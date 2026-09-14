#!/usr/bin/env node
/* Revisa los XML descargados y muestra, de cada uno, lo importante.
 *
 *   node tools/resumen-xml.js            # revisa ./xml
 *   node tools/resumen-xml.js xml        # la misma carpeta, explícita
 *   node tools/resumen-xml.js otra/ruta  # otra carpeta
 *
 * No valida el XML contra el esquema del SIFEN (eso necesita herramientas
 * extra): comprueba que sea el documento electrónico esperado —raíz <rDE>,
 * ítems, totales y firma digital— y resume los datos del comprobante.
 * Sin dependencias.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var cdc = require('../src/cdc.js');

var carpeta = process.argv[2] || 'xml';

function extraer(texto, etiqueta) {
  var m = texto.match(new RegExp('<' + etiqueta + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + etiqueta + '>'));
  return m ? m[1].trim() : null;
}

function contar(texto, etiqueta) {
  var m = texto.match(new RegExp('<' + etiqueta + '(?:\\s|>)', 'g'));
  return m ? m.length : 0;
}

function miles(n) {
  var x = String(n).trim();
  if (!/^-?\d+(\.\d+)?$/.test(x)) return x;
  var partes = x.split('.');
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return partes.join(',');
}

function revisar(archivo) {
  var texto = fs.readFileSync(archivo, 'utf8');
  var dId = extraer(texto, 'dId') || (texto.match(/Id="(\d{44})"/) || [])[1] || '';
  var analisis = dId ? cdc.analizarCdc(dId) : null;

  var filas = [];
  if (analisis) {
    filas.push('  CDC        ' + dId);
    filas.push(
      '  Documento  ' + analisis.tipoDocumentoNombre +
        '   Nº ' + analisis.establecimiento + '-' + analisis.puntoExpedicion + '-' + analisis.numeroDocumento
    );
    filas.push(
      '  Emisor     RUC ' + analisis.rucEmisor + '-' + analisis.dvRucEmisor +
        (extraer(texto, 'dNomEmi') ? '  ·  ' + extraer(texto, 'dNomEmi') : '')
    );
    filas.push(
      '  Emisión    ' + (telefonoFecha(analisis.fechaEmision) || 'sin fecha') +
        (extraer(texto, 'dFeEmiDE') ? '   (XML: ' + extraer(texto, 'dFeEmiDE') + ')' : '')
    );
  } else {
    filas.push('  CDC        (no encontrado en el archivo)');
  }

  var items = contar(texto, 'gCamItem');
  var total = extraer(texto, 'dTotGralOpe');
  var iva = extraer(texto, 'dTotIVA');
  filas.push(
    '  Contenido  ' + (fs.statSync(archivo).size / 1024).toFixed(1) + ' KB · ' +
      items + ' ítem(s)' + (total ? ' · total ' + miles(total) : '') + (iva ? ' · IVA ' + miles(iva) : '')
  );
  filas.push(
    '  Firma      ' + (contar(texto, 'Signature') ? 'sí, el XML está firmado' : 'NO se encontró la firma digital')
  );

  var problemas = [];
  if (!/^\s*(<\?xml|<rde|<rDE)/i.test(texto)) problemas.push('no parece XML');
  if (!/<rDE/i.test(texto)) problemas.push('no tiene la raíz <rDE>');
  if (!items) problemas.push('no tiene ítems (¿es el XML completo?)');
  if (!contar(texto, 'Signature')) problemas.push('sin firma digital');

  return { filas: filas, problemas: problemas };
}

function telefonoFecha(aaaammdd) {
  if (!/^\d{8}$/.test(aaaammdd || '')) return null;
  return aaaammdd.slice(6, 8) + '/' + aaaammdd.slice(4, 6) + '/' + aaaammdd.slice(0, 4);
}

/* ---------------------------------- main ----------------------------------- */

if (!fs.existsSync(carpeta)) {
  console.log('No existe la carpeta "' + carpeta + '".');
  console.log('Uso:  node tools/resumen-xml.js [carpeta]   (por defecto: xml)');
  process.exit(1);
}

var archivos = fs
  .readdirSync(carpeta)
  .filter(function (f) {
    return /\.xml$/i.test(f);
  })
  .sort();

console.log('Revisando ' + path.resolve(carpeta));
console.log('');

if (!archivos.length) {
  console.log('No hay archivos .xml en esa carpeta.');
  var otros = fs.readdirSync(carpeta);
  if (otros.length) console.log('Sí hay: ' + otros.join(', '));
  process.exit(0);
}

var conProblema = 0;
archivos.forEach(function (f, i) {
  if (i) console.log('');
  console.log('· ' + f);
  var r = revisar(path.join(carpeta, f));
  r.filas.forEach(function (linea) {
    console.log(linea);
  });
  if (r.problemas.length) {
    conProblema++;
    console.log('  ATENCIÓN    ' + r.problemas.join(' · '));
  }
});

console.log('');
console.log(
  archivos.length + ' archivo(s) XML  ·  ' + (archivos.length - conProblema) + ' con el documento completo' +
    (conProblema ? '  ·  ' + conProblema + ' para revisar' : '')
);
