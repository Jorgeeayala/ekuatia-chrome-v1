#!/usr/bin/env node
/* Autotest de las herramientas. Un solo comando:
 *
 *   node tools/pruebas/auto.js
 *
 * Parte A — unidades: composición y dígito verificador del CDC, extracción de
 *   un CDC desde texto libre, lector de "Copy as cURL" (bash y cmd), cookies,
 *   detección de XML y resumen de un DTE.
 * Parte B — punta a punta: levanta el servidor falso en sus cuatro modos y
 *   corre el descargador real contra él, comprobando que descarga lo que debe,
 *   que detecta los CDC sin XML, que reintenta los 401 por ráfaga y que no
 *   escribe archivos vacíos.
 *
 * No toca el portal de la DNIT ni necesita internet. Sale con código 0 si todo
 * pasa y 1 si algo falla.
 */

'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var { spawn } = require('child_process');

var RAIZ = path.resolve(__dirname, '..', '..');
var cdc = require(path.join(RAIZ, 'src', 'cdc.js'));
var red = require(path.join(RAIZ, 'tools', 'red.js'));

var PUERTO = 8123;
var BASE = 'http://127.0.0.1:' + PUERTO;
var CDC_OK = '01800975120007008007180822026080217723517894';
var CDC_SIN_XML = '01444444017001001001452822017012515873260988';
var OTRO_CDC = '01800084314075001002930022026080517312520869';

var pasadas = 0;
var falladas = 0;

function ok(titulo, condicion, detalle) {
  if (condicion) {
    pasadas++;
    console.log('  ✓ ' + titulo);
  } else {
    falladas++;
    console.log('  ✗ ' + titulo + (detalle ? '  →  ' + detalle : ''));
  }
}

function grupo(titulo) {
  console.log('');
  console.log(titulo);
}

/* ------------------------------- Parte A ---------------------------------- */

function unidades() {
  grupo('A · Unidades (sin red)');

  var analisis = cdc.analizarCdc(CDC_OK);
  ok('el CDC se descompone en sus campos', analisis.valido === true && analisis.rucEmisor === '80097512',
    JSON.stringify({ valido: analisis.valido, ruc: analisis.rucEmisor }));
  ok('detecta el tipo de documento', analisis.tipoDocumentoNombre === 'Factura electrónica',
    String(analisis.tipoDocumentoNombre));
  ok('la fecha de emisión sale del CDC', analisis.fechaEmision === '20260802', analisis.fechaEmision);

  // Un dígito cambiado tiene que fallar el módulo 11.
  ok('rechaza un CDC con el verificador mal', cdc.validarCdc(CDC_OK.slice(0, 43) + '5') === false);

  ok('extrae el CDC de un texto con espacios',
    cdc.extraerCdc('Factura 0180 0975 1200 0700 8007 1808 2202 6080 2177 2351 7894 de agosto') === CDC_OK);
  ok('extrae el CDC de un texto con guiones',
    cdc.extraerCdc('CDC: 0180-0975-1200-0700-8007-1808-2202-6080-2177-2351-7894') === CDC_OK);
  ok('formatea el CDC en grupos de cuatro',
    cdc.formatearCdc(CDC_OK) === '0180 0975 1200 0700 8007 1808 2202 6080 2177 2351 7894',
    cdc.formatearCdc(CDC_OK));

  var curlBash =
    "curl 'https://ekuatia.set.gov.py/docs/documento-electronico-xml/" + CDC_OK + "' \\\n" +
    "  -H 'accept: application/xml' \\\n" +
    "  -H 'cookie: JSESSIONID=ABC123' \\\n" +
    "  -H 'user-agent: Mozilla/5.0' \\\n" +
    '  --compressed';
  var c1 = red.parsearCurl(curlBash);
  ok('lee el "Copy as cURL" de bash', c1.url.indexOf(CDC_OK) > 0 && c1.cookie === 'JSESSIONID=ABC123',
    JSON.stringify({ url: c1.url, cookie: c1.cookie }));
  ok('separa la cookie de las demás cabeceras',
    c1.headers['cookie'] === undefined && c1.headers['accept'] === 'application/xml');

  var curlCmd =
    'curl ^"https://ekuatia.set.gov.py/docs/documento-electronico-xml/' + CDC_OK + '^" ' +
    '-H ^"cookie: JSESSIONID=ZZZ^" -H ^"accept: application/xml^" --compressed';
  var c2 = red.parsearCurl(curlCmd);
  ok('lee el "Copy as cURL" de cmd (^")', c2.cookie === 'JSESSIONID=ZZZ', JSON.stringify(c2.cookie));

  var jar = {};
  red.parsearCookie('JSESSIONID=AAA; otra=BBB; TS01abc=1', jar);
  ok('parsea varias cookies', jar.JSESSIONID === 'AAA' && jar.otra === 'BBB' && jar.TS01abc === '1',
    JSON.stringify(jar));
  ok('arma la cabecera Cookie', red.cabeceraCookie(jar) === 'JSESSIONID=AAA; otra=BBB; TS01abc=1',
    red.cabeceraCookie(jar));

  var h = red.cabeceras({ 'User-Agent': 'X' });
  ok('--header pisa la cabecera por defecto sin duplicarla',
    h['User-Agent'] === 'X' && Object.keys(h).filter(function (k) {
      return k.toLowerCase() === 'user-agent';
    }).length === 1);

  ok('recorta el cuerpo para el debug', red.recortar('a\nb   c', 10) === 'a b c');
  ok('no confunde una página HTML con un XML', !/^\s*(<\?xml|<rde|<rDE)/i.test('<!doctype html><html></html>'));
}

/* --------------------------- servidor falso -------------------------------- */

function arrancarMock(modo) {
  var proceso = spawn(process.execPath, [path.join(RAIZ, 'tools', 'pruebas', 'mock-ekuatia.js')], {
    env: Object.assign({}, process.env, { MOCK_MODO: modo, MOCK_PUERTO: String(PUERTO) }),
    stdio: 'ignore',
  });

  return new Promise(function (resolver, rechazar) {
    var intentos = 0;
    var reloj = setInterval(function () {
      var req = http.get(BASE + '/consultas/', function (res) {
        res.resume();
        clearInterval(reloj);
        resolver(proceso);
      });
      req.on('error', function () {
        if (++intentos > 60) {
          clearInterval(reloj);
          proceso.kill();
          rechazar(new Error('el servidor falso no arrancó'));
        }
      });
    }, 100);
  });
}

function correr(args) {
  return new Promise(function (resolver) {
    var p = spawn(process.execPath, [path.join(RAIZ, 'tools', 'descargar-xml.js')].concat(args), {
      cwd: RAIZ,
    });
    var salida = '';
    p.stdout.on('data', function (d) {
      salida += d;
    });
    p.stderr.on('data', function (d) {
      salida += d;
    });
    p.on('close', function (codigo) {
      resolver({ codigo: codigo, salida: salida });
    });
  });
}

function carpetaTemporal(nombre) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekua-auto-' + nombre + '-'));
  return dir;
}

function archivoConCdcs(dir, cdcs) {
  var f = path.join(dir, 'cdcs.txt');
  fs.writeFileSync(f, cdcs.join('\n') + '\n', 'utf8');
  return f;
}

function leerResumen(dir) {
  var f = path.join(dir, 'resumen.csv');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map(function (linea) {
      var m = linea.match(/^(\d+),([a-z-]+),(\d+),"(.*)"$/);
      return m ? { cdc: m[1], estado: m[2], bytes: Number(m[3]), detalle: m[4] } : null;
    })
    .filter(Boolean);
}

function xmlValido(dir, nombreCdc) {
  var f = path.join(dir, nombreCdc + '.xml');
  if (!fs.existsSync(f)) return false;
  var texto = fs.readFileSync(f, 'utf8');
  return /^\s*<\?xml/i.test(texto) && /<rDE/i.test(texto);
}

/* ------------------------------- Parte B ---------------------------------- */

async function puntaAPunta() {
  grupo('B · Punta a punta (contra el servidor falso)');

  /* --- modo público: el caso en que el portal responde sin nada especial --- */
  {
    var mock = await arrancarMock('publico');
    var dir = carpetaTemporal('publico');
    var entrada = archivoConCdcs(dir, [CDC_OK, CDC_SIN_XML, '01800975120007008007180822026080217723517895']);

    var r = await correr(['--base-url', BASE, '--entrada', entrada, '--salida', dir, '--pausa', '0', '--reintentos', '1']);
    var filas = leerResumen(dir);

    ok('descarga el XML del CDC bueno', xmlValido(dir, CDC_OK));
    ok('detecta el CDC sin XML público (200 + HTML vacío)',
      filas.some(function (f) {
        return f.cdc === CDC_SIN_XML && f.estado === 'no-encontrado';
      }));
    ok('no escribe un .xml vacío para el CDC sin XML', !fs.existsSync(path.join(dir, CDC_SIN_XML + '.xml')));
    ok('rechaza el CDC con el dígito verificador mal sin pedirlo',
      filas.some(function (f) {
        return f.estado === 'no-valido';
      }) && fs.readFileSync(path.join(dir, 'no_validos.txt'), 'utf8').indexOf('17895') > -1);
    ok('el resumen final cuenta bien', /Descargados: 1 \| sin XML público: 1 \| con error: 0/.test(r.salida),
      r.salida.trim().split('\n').slice(-3).join(' | '));
    ok('sale con código 0', r.codigo === 0, 'código ' + r.codigo);

    mock.kill();
  }

  /* --- modo cookie: el XML necesita la sesión que abre /consultas/ -------- */
  {
    var mock2 = await arrancarMock('cookie');
    var dir2 = carpetaTemporal('cookie');
    var entrada2 = archivoConCdcs(dir2, [CDC_OK]);

    var r2 = await correr(['--base-url', BASE, '--entrada', entrada2, '--salida', dir2, '--pausa', '0', '--reintentos', '1']);

    ok('abre sesión en /consultas/ y descarga con esa cookie', /sesión abierta en \/consultas\//.test(r2.salida) && xmlValido(dir2, CDC_OK),
      r2.salida.trim().split('\n')[0]);
    mock2.kill();
  }

  /* --- modo flaky: la primera petición de cada CDC da 401 ---------------- */
  {
    var mock3 = await arrancarMock('flaky');
    var dir3 = carpetaTemporal('flaky');
    var entrada3 = archivoConCdcs(dir3, [CDC_OK, OTRO_CDC]);

    var r3 = await correr([
      '--base-url', BASE, '--entrada', entrada3, '--salida', dir3,
      '--pausa', '0', '--pausa-fallo', '500', '--reintentos', '1',
    ]);

    ok('reintenta los 401 por ráfaga y termina bajando los dos',
      xmlValido(dir3, CDC_OK) && xmlValido(dir3, OTRO_CDC) && /Descargados: 2 \| sin XML público: 0 \| con error: 0/.test(r3.salida),
      r3.salida.trim().split('\n').slice(-3).join(' | '));
    ok('avisa que hubo una segunda pasada', /2ª pasada/.test(r3.salida));
    mock3.kill();
  }

  /* --- modo gate-cdc: sólo el CDC consultado (el caso del portal) --------- */
  {
    var mock4 = await arrancarMock('gate-cdc');
    var dir4 = carpetaTemporal('gate');
    var entrada4 = archivoConCdcs(dir4, [CDC_OK, OTRO_CDC]);

    var r4 = await correr([
      '--base-url', BASE, '--entrada', entrada4, '--salida', dir4,
      '--pausa', '0', '--pausa-fallo', '300', '--reintentos', '1',
    ]);
    var filas4 = leerResumen(dir4);

    ok('baja el CDC habilitado y no inventa el resto',
      xmlValido(dir4, CDC_OK) && !xmlValido(dir4, OTRO_CDC) &&
        filas4.some(function (f) {
          return f.cdc === OTRO_CDC && f.estado === 'error';
        }));
    ok('explica que es un freno del portal, no un CDC inválido',
      /siguen con 401 después de reintentar/.test(r4.salida), r4.salida.trim().split('\n').slice(-8).join(' | '));
    mock4.kill();
  }

  /* --- los archivos auxiliares que espera el flujo del mes --------------- */
  {
    var dir5 = carpetaTemporal('resumen');
    fs.mkdirSync(path.join(dir5, 'xml'), { recursive: true });
    fs.copyFileSync(
      path.join(RAIZ, 'tools', 'pruebas', 'ejemplo-dte.xml'),
      path.join(dir5, 'xml', CDC_OK + '.xml')
    );

    var salida = await new Promise(function (resolver) {
      var p = spawn(process.execPath, [path.join(RAIZ, 'tools', 'resumen-xml.js'), 'xml'], { cwd: dir5 });
      var s = '';
      p.stdout.on('data', function (d) {
        s += d;
      });
      p.on('close', function () {
        resolver(s);
      });
    });

    ok('resumen-xml.js lee un DTE completo y reporta firma e ítems',
      /Firma\s+sí, el XML está firmado/.test(salida) && /2 ítem\(s\)/.test(salida) && /1 archivo\(s\) XML/.test(salida),
      salida.trim().split('\n').slice(-2).join(' | '));

    var salidaMala = await new Promise(function (resolver) {
      fs.writeFileSync(path.join(dir5, 'xml', '01800084314075001002930022026080517312520869.xml'), '<!doctype html><html></html>');
      var p = spawn(process.execPath, [path.join(RAIZ, 'tools', 'resumen-xml.js'), 'xml'], { cwd: dir5 });
      var s = '';
      p.stdout.on('data', function (d) {
        s += d;
      });
      p.on('close', function () {
        resolver(s);
      });
    });

    ok('resumen-xml.js marca el archivo que no es un DTE', /ATENCIÓN/.test(salidaMala));
  }
}

/* ---------------------------------- main ----------------------------------- */

console.log('Autotest de ekuatia-chrome-v1 · Node ' + process.version);
console.log('(no toca el portal de la DNIT: usa el servidor falso)');

unidades();

puntaAPunta()
  .then(function () {
    console.log('');
    console.log((falladas ? '✗ ' : '✓ ') + pasadas + ' pruebas OK, ' + falladas + ' con problemas');
    process.exit(falladas ? 1 : 0);
  })
  .catch(function (err) {
    console.error('');
    console.error('El autotest se cortó: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
