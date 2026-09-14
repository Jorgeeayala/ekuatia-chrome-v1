#!/usr/bin/env node
/* Servidor falso que imita lo que sabemos del portal, para probar tools/ sin
 * depender de la red ni molestar al de la DNIT.
 *
 *   node tools/pruebas/mock-ekuatia.js            # modo cookie (por defecto)
 *   MOCK_MODO=publico  node tools/pruebas/mock-ekuatia.js
 *   MOCK_MODO=consulta node tools/pruebas/mock-ekuatia.js
 *
 * Modos:
 *   publico   el XML se sirve sin sesión (el caso viejo, cuando todo andaba)
 *   cookie    el XML se sirve con la cookie que deja /consultas/ (warmup)
 *   consulta  además exige que la sesión haya consultado ese CDC (captcha),
 *             que es lo que parece pedir el portal hoy
 *
 * Después:
 *   node tools/descargar-xml.js --base-url http://127.0.0.1:8099 <CDC>
 *   node tools/diagnostico.js   --base-url http://127.0.0.1:8099 <CDC>
 */

'use strict';

var http = require('http');
var crypto = require('crypto');

var PUERTO = Number(process.env.MOCK_PUERTO || 8099);
var MODO = process.env.MOCK_MODO || 'cookie';
var CDC_BUENO = '01800975120007008007180822026080217723517894';
var PAGINA_VACIA = '<!doctype html><html><head></head><body></body></html>';

var sesiones = Object.create(null); // id -> { consultados: { cdc: true } }

function xmlDe(cdc) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><dId>' +
    cdc +
    '</dId><gCamItem><dDesProSer>prueba</dDesProSer></gCamItem></rDE>\n'
  );
}

function json(res, estado, datos, cabeceras) {
  res.writeHead(estado, Object.assign({ 'Content-Type': 'application/json' }, cabeceras || {}));
  res.end(JSON.stringify(datos));
}

function html(res, estado, cuerpo, cabeceras) {
  res.writeHead(estado, Object.assign({ 'Content-Type': 'text/html;charset=UTF-8' }, cabeceras || {}));
  res.end(cuerpo);
}

var servidor = http.createServer(function (req, res) {
  var url = new URL(req.url, 'http://127.0.0.1:' + PUERTO);
  var cookies = Object.create(null);
  String(req.headers.cookie || '')
    .split(';')
    .forEach(function (par) {
      var i = par.indexOf('=');
      if (i > 0) cookies[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });

  var id = cookies.JSESSIONID;

  // La pantalla de consultas: entrega la cookie de sesión.
  if (url.pathname === '/' || url.pathname === '/consultas/' || url.pathname.indexOf('/consultas/') === 0) {
    if (!id) {
      id = crypto.randomBytes(8).toString('hex');
      sesiones[id] = { consultados: Object.create(null) };
      return html(res, 200, '<html><body>Servicios y Consultas</body></html>', {
        'Set-Cookie': 'JSESSIONID=' + id + '; Path=/; HttpOnly',
      });
    }
    if (!sesiones[id]) sesiones[id] = { consultados: Object.create(null) };
    return html(res, 200, '<html><body>Servicios y Consultas</body></html>');
  }

  // Consulta por CDC (lo que hace la pantalla antes de mostrar el XML).
  if (url.pathname === '/docs/documento-electronico' && req.method === 'POST') {
    var cuerpo = '';
    req.on('data', function (t) {
      cuerpo += t;
    });
    req.on('end', function () {
      var datos = {};
      try {
        datos = JSON.parse(cuerpo || '{}');
      } catch (e) {
        /* JSON inválido */
      }
      if (!id) return json(res, 401, { mensaje: 'Sesión no iniciada. Realice una nueva consulta.' });
      if (datos.captcha !== 'ok') {
        return json(res, 200, { mensaje: 'Captcha inválido', DE: null });
      }
      sesiones[id].consultados[datos.cdc] = true;
      return json(res, 200, { DE: { '@Id': datos.cdc }, DTE: { dEstRes: 'Aprobado' } });
    });
    return;
  }

  // Descarga del XML.
  var prefijo = '/docs/documento-electronico-xml/';
  if (url.pathname.indexOf(prefijo) === 0) {
    var cdcPedido = url.pathname.slice(prefijo.length);
    if (MODO !== 'publico' && !(id && sesiones[id])) {
      return json(res, 401, { mensaje: 'Sesión no iniciada. Realice una nueva consulta para la descarga.' });
    }
    if (MODO === 'consulta' && !(sesiones[id] && sesiones[id].consultados[cdcPedido])) {
      return json(res, 401, { mensaje: 'Tiempo de sesión finalizado. Realice una nueva consulta para la descarga.' });
    }
    if (cdcPedido === CDC_BUENO) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(xmlDe(cdcPedido));
    }
    return html(res, 200, PAGINA_VACIA);
  }

  if (url.pathname === '/docs/' || url.pathname === '/docs') return html(res, 404, 'Not Found');
  return html(res, 404, 'Not Found');
});

servidor.listen(PUERTO, '127.0.0.1', function () {
  console.log('mock e-Kuatia escuchando en http://127.0.0.1:' + PUERTO + ' · modo ' + MODO);
  console.log('CDC bueno: ' + CDC_BUENO);
});
