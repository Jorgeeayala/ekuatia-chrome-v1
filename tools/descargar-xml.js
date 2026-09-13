#!/usr/bin/env node
/* Descarga el XML de los comprobantes electrónicos (DTE) desde e-Kuatia.
 *
 * Uso:
 *   node tools/descargar-xml.js 01800975120007008007180822026080217723517894
 *   node tools/descargar-xml.js --entrada cdcs.txt
 *   node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --pausa 1500
 *
 * Notas:
 *   - El endpoint es público: no necesita certificado, sesión ni captcha.
 *     Documentado en ../DESCARGA-XML.md.
 *   - Ante un CDC que no existe, no está aprobado o fue inutilizado, el
 *     servidor responde 200 con un HTML vacío. Por eso la respuesta se
 *     valida antes de guardar: nunca se escribe un .xml vacío.
 *   - Sin dependencias (usa el fetch de Node 18+).
 */

'use strict';

var fs = require('fs');
var path = require('path');
var cdc = require('../src/cdc.js');

var ENDPOINT = 'https://ekuatia.set.gov.py/docs/documento-electronico-xml/';
var RE_XML = /^\s*(<\?xml|<rde|<rDE)/i;

/* ------------------------------- argumentos -------------------------------- */

function parsearArgumentos(argv) {
  var opts = {
    entrada: null,
    salida: 'xml',
    pausa: 1200,
    reintentos: 3,
    nombreCorto: true,
    cdcs: [],
  };

  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--entrada' || a === '-i') opts.entrada = argv[++i];
    else if (a === '--salida' || a === '-o') opts.salida = argv[++i];
    else if (a === '--pausa') opts.pausa = Number(argv[++i]);
    else if (a === '--reintentos') opts.reintentos = Number(argv[++i]);
    else if (a === '--nombre-largo') opts.nombreCorto = false;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--ayuda' || a === '-h') opts.ayuda = true;
    else opts.cdcs.push(a);
  }
  return opts;
}

function ayuda() {
  console.log(
    [
      'Descarga el XML de DTEs de e-Kuatia por CDC.',
      '',
      '  node tools/descargar-xml.js <CDC> [<CDC>...]',
      '  node tools/descargar-xml.js --entrada cdcs.txt [--salida ./xml]',
      '',
      '  --entrada, -i    archivo con un CDC por línea (acepta espacios, puntos o guiones)',
      '  --salida,  -o    carpeta de destino (por defecto: ./xml)',
      '  --pausa          milisegundos entre descargas (por defecto: 1200)',
      '  --reintentos     reintentos ante errores de red o 5xx (por defecto: 3)',
      '  --nombre-largo   nombra el archivo como AAAA-MM-DD_RUC-numero_CDC.xml',
      '  --debug          muestra estado, content-type y un trozo de la respuesta',
      '                   cuando algo no llega como XML (para diagnosticar cambios',
      '                   en el endpoint del portal)',
      '',
      'Deja en la carpeta de salida:',
      '  <CDC>.xml                 los XML descargados',
      '  no_encontrados.txt        CDC válidos sin XML (inexistente, rechazado, inutilizado)',
      '  no_validos.txt            líneas que no son un CDC de 44 dígitos con DV correcto',
      '  resumen.csv               CDC, estado, bytes y archivo',
    ].join('\n')
  );
}

/* ------------------------------- utilidades -------------------------------- */

function esperar(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function leerCdcs(opts) {
  var lineas = [];
  if (opts.entrada) {
    var contenido = fs.readFileSync(opts.entrada, 'utf8');
    lineas = contenido.split(/\r?\n/);
  }
  return lineas.concat(opts.cdcs);
}

/** Nombre del archivo de salida para un CDC ya analizado. */
function nombreArchivo(analisis, nombreCorto) {
  if (nombreCorto) return analisis.cdc + '.xml';
  var fecha = /^\d{8}$/.test(analisis.fechaEmision)
    ? analisis.fechaEmision.slice(0, 4) +
      '-' +
      analisis.fechaEmision.slice(4, 6) +
      '-' +
      analisis.fechaEmision.slice(6, 8)
    : 'sin-fecha';
  var numero =
    analisis.establecimiento + '-' + analisis.puntoExpedicion + '-' + analisis.numeroDocumento;
  return [fecha, analisis.rucEmisor + '-' + analisis.dvRucEmisor, numero, analisis.cdc].join('_') + '.xml';
}

/* -------------------------------- descarga --------------------------------- */

/** Descarga un CDC. Devuelve {estado, bytes, archivo, detalle}. */
async function descargarUno(cdcLimpio, opts) {
  var url = ENDPOINT + cdcLimpio;
  var ultimoError = null;

  for (var intento = 1; intento <= opts.reintentos; intento++) {
    try {
      var resp = await fetch(url, {
        headers: { Accept: 'application/xml' },
        redirect: 'follow',
      });

      // 5xx y 429 se reintentan con backoff; el resto se resuelve acá.
      if (resp.status >= 500 || resp.status === 429) {
        ultimoError = 'HTTP ' + resp.status;
        await esperar(1000 * Math.pow(2, intento - 1));
        continue;
      }
      if (!resp.ok) return { estado: 'error', detalle: 'HTTP ' + resp.status };

      var texto = await resp.text();
      if (!RE_XML.test(texto)) {
        // El servidor responde 200 con un HTML vacío cuando el CDC no tiene
        // XML público: inexistente, no aprobado, rechazado o inutilizado.
        if (opts.debug) {
          var muestra = texto.replace(/\s+/g, ' ').trim().slice(0, 200);
          console.log(
            '    [debug] HTTP ' +
              resp.status +
              ' · ' +
              (resp.headers && resp.headers.get ? resp.headers.get('content-type') : '?') +
              ' · ' +
              (muestra || '(respuesta vacía)')
          );
        }
        return { estado: 'no-encontrado', detalle: 'sin XML público' };
      }

      var analisis = cdc.analizarCdc(cdcLimpio);
      var archivo = path.join(opts.salida, nombreArchivo(analisis, opts.nombreCorto));
      fs.writeFileSync(archivo, texto, 'utf8');

      return {
        estado: 'descargado',
        bytes: Buffer.byteLength(texto, 'utf8'),
        archivo: archivo,
      };
    } catch (err) {
      ultimoError = err && err.message ? err.message : String(err);
      await esperar(1000 * Math.pow(2, intento - 1));
    }
  }

  return { estado: 'error', detalle: ultimoError || 'sin detalle' };
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  var opts = parsearArgumentos(process.argv);
  if (opts.ayuda) return ayuda();

  var lineas = leerCdcs(opts);
  if (!lineas.length) return ayuda();

  fs.mkdirSync(opts.salida, { recursive: true });

  var resumen = [];
  var noEncontrados = [];
  var noValidos = [];
  var vistos = Object.create(null);
  var totales = { descargado: 0, 'no-encontrado': 0, error: 0, 'no-valido': 0, duplicado: 0 };

  for (var i = 0; i < lineas.length; i++) {
    var linea = lineas[i].trim();
    if (!linea) continue;

    var cdcLimpio = cdc.extraerCdc(linea);
    if (!cdcLimpio || !cdc.validarCdc(cdcLimpio)) {
      noValidos.push(linea);
      totales['no-valido']++;
      resumen.push([linea, 'no-valido', 0, '']);
      console.log('✗ no válido     ' + linea);
      continue;
    }
    if (vistos[cdcLimpio]) {
      totales.duplicado++;
      continue;
    }
    vistos[cdcLimpio] = true;

    var r = await descargarUno(cdcLimpio, opts);
    totales[r.estado] = (totales[r.estado] || 0) + 1;

    if (r.estado === 'descargado') {
      console.log(
        '✓ ' + cdcLimpio + '  ' + (r.bytes / 1024).toFixed(1) + ' KB  →  ' + r.archivo
      );
      resumen.push([cdcLimpio, 'descargado', r.bytes, r.archivo]);
    } else if (r.estado === 'no-encontrado') {
      console.log('· ' + cdcLimpio + '  sin XML público');
      noEncontrados.push(cdcLimpio);
      resumen.push([cdcLimpio, 'no-encontrado', 0, '']);
    } else {
      console.log('! ' + cdcLimpio + '  error: ' + r.detalle);
      resumen.push([cdcLimpio, 'error', 0, r.detalle || '']);
    }

    if (i < lineas.length - 1) await esperar(opts.pausa);
  }

  if (noEncontrados.length) {
    fs.writeFileSync(
      path.join(opts.salida, 'no_encontrados.txt'),
      noEncontrados.join('\n') + '\n',
      'utf8'
    );
  }
  if (noValidos.length) {
    fs.writeFileSync(path.join(opts.salida, 'no_validos.txt'), noValidos.join('\n') + '\n', 'utf8');
  }
  fs.writeFileSync(
    path.join(opts.salida, 'resumen.csv'),
    ['cdc,estado,bytes,archivo']
      .concat(
        resumen.map(function (fila) {
          // El cuarto campo es una ruta: puede llevar comas.
          return [
            fila[0],
            fila[1],
            fila[2],
            '"' + String(fila[3]).replace(/"/g, '""') + '"',
          ].join(',');
        })
      )
      .join('\n') + '\n',
    'utf8'
  );

  console.log('');
  console.log('Descargados: ' + totales.descargado + ' | sin XML público: ' + totales['no-encontrado'] +
    ' | con error: ' + (totales.error || 0) + ' | no válidos: ' + totales['no-valido'] +
    (totales.duplicado ? ' | duplicados: ' + totales.duplicado : ''));
  console.log('Carpeta: ' + path.resolve(opts.salida));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
