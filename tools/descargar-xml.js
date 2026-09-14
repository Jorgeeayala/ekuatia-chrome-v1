#!/usr/bin/env node
/* Descarga el XML de los comprobantes electrónicos (DTE) desde e-Kuatia.
 *
 * Uso:
 *   node tools/descargar-xml.js 01800975120007008007180822026080217723517894
 *   node tools/descargar-xml.js --entrada cdcs.txt
 *   node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --debug
 *   node tools/descargar-xml.js --entrada cdcs.txt --warmup --header "User-Agent: Mozilla/5.0 ..."
 *
 * Notas:
 *   - El endpoint es público pero el servidor puede exigir cabeceras de
 *     navegador y/o una cookie de sesión: ante un 401 hay que probar con
 *     --warmup (visita /consultas/ antes y reutiliza la cookie) y/o --header.
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
var PAGINA_CONSULTA = 'https://ekuatia.set.gov.py/consultas/';
var RE_XML = /^\s*(<\?xml|<rde|<rDE)/i;

/* ------------------------------- argumentos -------------------------------- */

function parsearArgumentos(argv) {
  var opts = {
    entrada: null,
    salida: 'xml',
    pausa: 1200,
    reintentos: 3,
    nombreCorto: true,
    debug: false,
    warmup: false,
    headers: [],
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
    else if (a === '--warmup') opts.warmup = true;
    else if (a === '--header' || a === '-H') opts.headers.push(argv[++i]);
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
      '  --debug          muestra estado, cabeceras y un trozo de la respuesta',
      '  --warmup         visita /consultas/ antes y reutiliza su cookie de sesión',
      '  --header, -H     cabecera extra, repetible: -H "User-Agent: Mozilla/5.0 ..."',
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

/** Arma las cabeceras: las fijas + las de --header + la cookie si hay. */
function construirHeaders(opts, jar) {
  var h = { Accept: 'application/xml' };
  for (var i = 0; i < opts.headers.length; i++) {
    var partes = opts.headers[i].split(':');
    if (partes.length >= 2) h[partes.shift().trim()] = partes.join(':').trim();
  }
  var nombres = Object.keys(jar || {});
  if (nombres.length) {
    h.Cookie = nombres
      .map(function (n) {
        return n + '=' + jar[n];
      })
      .join('; ');
  }
  return h;
}

/** Guarda en el jar las cookies que vengan en la respuesta. */
function guardarCookies(resp, jar) {
  if (!resp.headers) return;
  var crudas = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : resp.headers.get('set-cookie');
  var lista = Array.isArray(crudas) ? crudas : crudas ? [String(crudas)] : [];

  lista.forEach(function (c) {
    var par = c.split(';')[0];
    var i = par.indexOf('=');
    if (i > 0) jar[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  });
}

/** Muestra todo lo que el servidor contestó, para diagnosticar. */
function depurar(etiqueta, resp, texto, opts) {
  if (!opts.debug) return;
  var lineas = ['    [debug] ' + etiqueta + ' HTTP ' + resp.status];
  var contentType = resp.headers && resp.headers.get ? resp.headers.get('content-type') : null;
  if (contentType) lineas.push('content-type: ' + contentType);

  var auth = resp.headers && resp.headers.get ? resp.headers.get('www-authenticate') : null;
  if (auth) lineas.push('www-authenticate: ' + auth);

  if (texto != null) {
    var muestra = texto.replace(/\s+/g, ' ').trim().slice(0, 300);
    lineas.push('cuerpo: ' + (muestra || '(vacío)'));
  }
  console.log(lineas.join('\n             '));
}

/** Cabeceras de la petición, tal como se enviaron (sin la cookie completa). */
function depurarPeticion(headers, opts) {
  if (!opts.debug) return;
  var copia = {};
  Object.keys(headers).forEach(function (k) {
    copia[k] = k.toLowerCase() === 'cookie' ? '(oculta)' : headers[k];
  });
  console.log('    [debug] cabeceras: ' + JSON.stringify(copia));
}

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
  return (
    [fecha, analisis.rucEmisor + '-' + analisis.dvRucEmisor, numero, analisis.cdc].join('_') + '.xml'
  );
}

/* ---------------------------- sesión (warmup) ------------------------------ */

/** Visita /consultas/ para que el servidor nos dé su cookie de sesión. */
async function warmup(jar, opts) {
  var headers = { Accept: 'text/html' };
  for (var i = 0; i < opts.headers.length; i++) {
    var partes = opts.headers[i].split(':');
    if (partes.length >= 2) headers[partes.shift().trim()] = partes.join(':').trim();
  }

  try {
    var resp = await fetch(PAGINA_CONSULTA, { headers: headers, redirect: 'follow' });
    guardarCookies(resp, jar);
    console.log(
      '· warmup /consultas/ → HTTP ' +
        resp.status +
        ' · cookies: ' +
        (Object.keys(jar).join(', ') || 'ninguna')
    );
    return resp.status;
  } catch (err) {
    console.log('· warmup falló: ' + (err && err.message ? err.message : err));
    return 0;
  }
}

/* -------------------------------- descarga --------------------------------- */

async function descargarUno(cdcLimpio, opts, jar) {
  var url = ENDPOINT + cdcLimpio;
  var headers = construirHeaders(opts, jar);
  var ultimoError = null;

  for (var intento = 1; intento <= opts.reintentos; intento++) {
    try {
      depurarPeticion(headers, opts);
      var resp = await fetch(url, { headers: headers, redirect: 'follow' });

      // 5xx y 429 se reintentan con backoff; el resto se resuelve acá.
      if (resp.status >= 500 || resp.status === 429) {
        ultimoError = 'HTTP ' + resp.status;
        depurar('reintento ' + intento, resp, null, opts);
        await esperar(1000 * Math.pow(2, intento - 1));
        continue;
      }

      var texto = await resp.text();

      if (!resp.ok) {
        // 401/403: el servidor nos está rechazando. El cuerpo suele decir por
        // qué (falta cookie, falta User-Agent, WAF, etc.).
        depurar('rechazo', resp, texto, opts);
        return { estado: 'error', detalle: 'HTTP ' + resp.status };
      }

      if (!RE_XML.test(texto)) {
        depurar('no es XML', resp, texto, opts);
        return { estado: 'no-encontrado', detalle: 'sin XML público' };
      }

      var analisis = cdc.analizarCdc(cdcLimpio);
      var archivo = path.join(opts.salida, nombreArchivo(analisis, opts.nombreCorto));
      fs.writeFileSync(archivo, texto, 'utf8');

      return { estado: 'descargado', bytes: Buffer.byteLength(texto, 'utf8'), archivo: archivo };
    } catch (err) {
      ultimoError = err && err.message ? err.message : String(err);
      if (opts.debug) console.log('    [debug] excepción: ' + ultimoError);
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

  var jar = {};
  if (opts.warmup) await warmup(jar, opts);

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

    var r = await descargarUno(cdcLimpio, opts, jar);
    totales[r.estado] = (totales[r.estado] || 0) + 1;

    if (r.estado === 'descargado') {
      console.log('✓ ' + cdcLimpio + '  ' + (r.bytes / 1024).toFixed(1) + ' KB  →  ' + r.archivo);
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
  console.log(
    'Descargados: ' + totales.descargado + ' | sin XML público: ' + totales['no-encontrado'] +
      ' | con error: ' + (totales.error || 0) + ' | no válidos: ' + totales['no-valido'] +
      (totales.duplicado ? ' | duplicados: ' + totales.duplicado : '')
  );
  console.log('Carpeta: ' + path.resolve(opts.salida));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
