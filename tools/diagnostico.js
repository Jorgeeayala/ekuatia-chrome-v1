#!/usr/bin/env node
/* Diagnóstico del 401 al descargar XML de e-Kuatia.
 *
 * Corre una batería de sondas contra el portal y dice qué está pasando y qué
 * camino usar. No descarga nada: sólo pregunta y muestra lo que contesta.
 *
 * Uso:
 *   node tools/diagnostico.js 01800975120007008007180822026080217723517894
 *   node tools/diagnostico.js --entrada cdcs.txt
 *   node tools/diagnostico.js --entrada cdcs.txt --curl captura-curl.txt
 *   node tools/diagnostico.js --entrada cdcs.txt --cookie "JSESSIONID=ABC"
 *
 * Sondas:
 *   1. ¿Responde el portal a un cliente simple (sólo Accept)?
 *   2. ¿Responde con cabeceras de Chrome?
 *   3. GET del XML sin sesión (cliente simple).
 *   4. GET del XML sin sesión (cabeceras de Chrome).
 *   5. Abrir sesión en /consultas/ y reintentar el GET con esa cookie.
 *   6. POST /docs/documento-electronico {cdc, captcha:""}.
 *   7. Si pasaste --curl/--cookie: el mismo GET con tu sesión del navegador.
 *   8. Si pasaste --curl/--cookie: el POST con tu sesión del navegador.
 *
 * Sin dependencias (fetch de Node 18+). Ver DESCARGA-XML.md → "Si da 401".
 */

'use strict';

var fs = require('fs');
var cdc = require('../src/cdc.js');
var red = require('./red.js');

var TIEMPO_LIMITE_MS = 20000;

/* ------------------------------- argumentos -------------------------------- */

function parsearArgumentos(argv) {
  var opts = { entrada: null, curl: null, cookie: null, base: null, debug: false, headers: [], cdcs: [] };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--entrada' || a === '-i') opts.entrada = argv[++i];
    else if (a === '--curl') opts.curl = argv[++i];
    else if (a === '--cookie') opts.cookie = argv[++i];
    else if (a === '--cookie-archivo') opts.cookie = '@' + argv[++i];
    else if (a === '--base-url') opts.base = argv[++i];
    else if (a === '--header' || a === '-H') opts.headers.push(argv[++i]);
    else if (a === '--debug') opts.debug = true;
    else if (a === '--ayuda' || a === '-h') opts.ayuda = true;
    else opts.cdcs.push(a);
  }
  return opts;
}

function ayuda() {
  console.log(
    [
      'Diagnóstico del 401 al descargar XML de e-Kuatia.',
      '',
      '  node tools/diagnostico.js <CDC>',
      '  node tools/diagnostico.js --entrada cdcs.txt',
      '  node tools/diagnostico.js --entrada cdcs.txt --curl captura-curl.txt',
      '  node tools/diagnostico.js --entrada cdcs.txt --cookie "JSESSIONID=ABC"',
      '',
      '  --entrada, -i     archivo con un CDC por línea',
      '  --curl AR         "Copy as cURL" de la descarga en Chrome (archivo o texto)',
      '  --cookie X        cookie de sesión del navegador',
      '  --header, -H      cabecera extra, repetible',
      '  --debug           muestra también las cabeceras de cada respuesta',
      '',
      'Pegá la salida completa (o el archivo diagnostico-401.txt) para cerrar el caso.',
    ].join('\n')
  );
}

/* ------------------------------- utilidades -------------------------------- */

function leerTexto(opts) {
  var lineas = [];
  if (opts.entrada) lineas = fs.readFileSync(opts.entrada, 'utf8').split(/\r?\n/);
  lineas = lineas.concat(opts.cdcs);

  var cdcs = [];
  lineas.forEach(function (linea) {
    var limpio = cdc.extraerCdc(linea);
    if (limpio && cdc.validarCdc(limpio)) cdcs.push(limpio);
  });
  return cdcs;
}

/** Clasifica el cuerpo de la respuesta en una línea legible. */
function clasificar(texto) {
  if (texto == null) return '(sin cuerpo)';
  var t = String(texto).trim();
  if (!t) return '(cuerpo vacío, 0 bytes)';
  if (/^(\<\?xml|\<rde|\<rDE)/i.test(t)) return 'XML ✓ (' + t.length + ' bytes)';
  if (/^<!doctype html><html><head><\/head><body><\/body><\/html>/i.test(t))
    return 'HTML vacío (la página en blanco del portal)';
  if (/^[{[]/.test(t)) return 'JSON → ' + red.recortar(t, 240);
  if (/captcha/i.test(t)) return 'menciona captcha → ' + red.recortar(t, 240);
  if (/^\s*</.test(t)) return 'HTML → ' + red.recortar(t, 240);
  return 'texto → ' + red.recortar(t, 240);
}

function cabeceraDe(resp, nombre) {
  var v = resp && resp.headers && resp.headers.get ? resp.headers.get(nombre) : null;
  return v || null;
}

/** Una sonda: hace la petición, guarda la cookie (si corresponde) y la imprime. */
async function sonda(indice, titulo, url, opciones, ctx) {
  var etiqueta = indice + ') ' + titulo;
  var relleno = etiqueta.length < 52 ? etiqueta + ' '.repeat(52 - etiqueta.length) : etiqueta + ' ';

  var resp;
  try {
    if (!opciones.headers) delete opciones.headers;
    resp = await fetch(url, Object.assign({ redirect: 'follow', signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }, opciones));
  } catch (err) {
    console.log(relleno + '✗ ' + (err && err.message ? err.message : err));
    return { estado: 'fallo', error: String(err && err.message) };
  }

  if (ctx && ctx.jar) red.cookiesDeRespuesta(resp, ctx.jar);

  var texto = await resp.text();
  var ct = cabeceraDe(resp, 'content-type') || '(sin content-type)';
  console.log(relleno + 'HTTP ' + resp.status + '  ·  ' + ct.split(';')[0]);
  console.log('     cuerpo: ' + clasificar(texto));

  if (ctx && ctx.opts && ctx.opts.debug) {
    ['www-authenticate', 'server', 'location'].forEach(function (n) {
      var v = cabeceraDe(resp, n);
      if (v) console.log('     ' + n + ': ' + red.recortar(v, 200));
    });
    var set = cabeceraDe(resp, 'set-cookie');
    if (set) console.log('     set-cookie: ' + red.recortar(set, 160));
  }

  return { estado: resp.status, texto: texto, resp: resp };
}

function esXml(r) {
  return r && typeof r.texto === 'string' && /^(\<\?xml|\<rde|\<rDE)/i.test(r.texto.trim());
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  var opts = parsearArgumentos(process.argv);
  if (opts.ayuda) return ayuda();

  var cdcs = leerTexto(opts);
  if (!cdcs.length) {
    console.log('Necesito al menos un CDC válido (44 dígitos, dígito verificador correcto).');
    console.log('  node tools/diagnostico.js --entrada cdcs.txt\n');
    return ayuda();
  }
  var cdcPrueba = cdcs[0];

  var base = red.base(opts);
  var urlConsulta = red.paginaConsulta(opts);
  var urlXml = red.endpointXml(opts) + cdcPrueba;
  var urlJson = red.endpointJson(opts);

  var captura = null;
  if (opts.curl) {
    var crudo = opts.curl;
    if (fs.existsSync(crudo)) crudo = fs.readFileSync(crudo, 'utf8');
    captura = red.parsearCurl(crudo);
    if (!captura.url && !captura.cookie && !Object.keys(captura.headers).length) {
      console.log('· no pude leer la captura de --curl (¿pegaste el "Copy as cURL" completo?)');
    }
  }

  var headersChrome = red.cabeceras(red.headersDeLista(opts.headers));
  var headersSimple = { Accept: 'application/xml' };

  var jarSesion = {}; // cookies que devuelve el portal (warmup)
  var jarNavegador = {}; // cookies aportadas con --curl/--cookie

  if (captura) {
    Object.keys(captura.headers).forEach(function (k) {
      headersChrome[k] = captura.headers[k];
    });
    if (captura.cookie) red.parsearCookie(captura.cookie, jarNavegador);
  }
  if (opts.cookie) {
    if (opts.cookie.charAt(0) === '@') red.parsearCookie(fs.readFileSync(opts.cookie.slice(1), 'utf8'), jarNavegador);
    else red.parsearCookie(opts.cookie, jarNavegador);
  }
  var haySesionImportada = Object.keys(jarNavegador).length > 0;

  /** Cabeceras de la petición tal como las haría el navegador con esa sesión. */
  function conCookie(base, jar) {
    var h = {};
    Object.keys(base).forEach(function (k) {
      h[k] = base[k];
    });
    if (jar) {
      var c = red.cabeceraCookie(jar);
      if (c) h.Cookie = c;
    }
    return h;
  }

  var headersNavegador = conCookie(headersChrome, Object.keys(jarNavegador).length ? jarNavegador : null);

  console.log('Diagnóstico de descarga de XML · e-Kuatia');
  console.log('  portal:            ' + base);
  console.log('  CDC de prueba:     ' + cdcPrueba + '  (' + (cdcs.length - 1) + ' más en la lista)');
  console.log('  sesión importada:  ' + (haySesionImportada ? 'sí · cookies: ' + red.nombresDeJar(jarNavegador) : 'no (--curl/--cookie)'));
  console.log('  cliente:           ' + (captura ? 'navegador + tu captura de Chrome' : 'navegador (cabeceras de Chrome)'));
  console.log('');
  console.log('Sondas');
  console.log('');

  var resultados = {};

  resultados.consultaSimple = await sonda(1, 'GET /consultas/ (cliente simple)', urlConsulta, { headers: { Accept: 'text/html' } });
  resultados.consultaChrome = await sonda(2, 'GET /consultas/ (cabeceras de Chrome)', urlConsulta, { headers: headersChrome }, { jar: jarSesion, opts: opts });
  resultados.xmlSimple = await sonda(3, 'GET XML sin sesión (cliente simple)', urlXml, { headers: headersSimple });
  resultados.xmlChrome = await sonda(4, 'GET XML sin sesión (cabeceras de Chrome)', urlXml, { headers: headersChrome });
  resultados.xmlWarmup = await sonda(
    5,
    'GET XML con la sesión de /consultas/',
    urlXml,
    { headers: conCookie(headersChrome, jarSesion) },
    { jar: jarSesion, opts: opts }
  );
  resultados.jsonChrome = await sonda(
    6,
    'POST /docs/documento-electronico {cdc}',
    urlJson,
    {
      method: 'POST',
      headers: Object.assign(conCookie(headersChrome, jarSesion), {
        'Content-Type': 'application/json',
        Accept: 'application/json, */*',
      }),
      body: JSON.stringify({ cdc: cdcPrueba, captcha: '' }),
    },
    { jar: jarSesion, opts: opts }
  );

  if (haySesionImportada) {
    resultados.xmlImportada = await sonda(7, 'GET XML con tu sesión (--curl/--cookie)', urlXml, { headers: headersNavegador }, { jar: jarNavegador, opts: opts });
    resultados.jsonImportada = await sonda(
      8,
      'POST consulta con tu sesión (--curl/--cookie)',
      urlJson,
      {
        method: 'POST',
        headers: Object.assign({}, headersNavegador, { 'Content-Type': 'application/json', Accept: 'application/json, */*' }),
        body: JSON.stringify({ cdc: cdcPrueba, captcha: '' }),
      },
      { jar: jarNavegador, opts: opts }
    );
  }

  /* ------------------------------- veredicto ------------------------------- */

  var v = veredicto(resultados, haySesionImportada, captura);
  console.log('');
  console.log('Veredicto');
  console.log('');
  v.forEach(function (linea) {
    console.log('  ' + linea);
  });

  var salida = montarInforme(base, cdcPrueba, cdcs.length, resultados, v);
  var destino = 'diagnostico-401.txt';
  fs.writeFileSync(destino, salida, 'utf8');
  console.log('');
  console.log('Informe guardado en ' + destino + ' (pegalo tal cual para cerrar el caso).');
}

function veredicto(r, haySesionImportada, captura) {
  var l = [];
  var xmlPublico = esXml(r.xmlChrome);
  var xmlWarmup = esXml(r.xmlWarmup);
  var xmlImportada = esXml(r.xmlImportada);
  var xmlApi = esXml(r.jsonChrome);
  var xmlApiImportada = esXml(r.jsonImportada);
  var consultaSimple401 = r.consultaSimple && (r.consultaSimple.estado === 401 || r.consultaSimple.estado === 403);
  var consultaChromeOk = r.consultaChrome && r.consultaChrome.estado === 200;
  var vacioSinSesion = r.xmlChrome && r.xmlChrome.estado === 200 && !esXml(r.xmlChrome);

  if (xmlApi) {
    l.push('✔ La API JSON (sonda 6) devolvió el XML: usá el descargador con --api.');
    return l;
  }
  if (xmlImportada || xmlApiImportada) {
    l.push('✔ Con tu sesión del navegador la descarga funciona.');
    l.push('  Corré el lote con:  node tools/descargar-xml.js --entrada cdcs.txt ' +
      (captura ? '--curl captura-curl.txt' : '--cookie "' + '<la cookie>' + '"'));
    l.push('  Ojo: si el portal exige que el CDC se haya consultado antes, cada CDC nuevo');
    l.push('  necesita su consulta en el navegador (captcha incluido). Probá con un segundo CDC.');
    return l;
  }
  if (xmlPublico) {
    l.push('✔ El endpoint respondió XML sin sesión (sonda 4): este CDC se puede bajar');
    l.push('  directo. Corré el lote normal (ya manda cabeceras de Chrome):');
    l.push('    node tools/descargar-xml.js --entrada cdcs.txt');
    return l;
  }
  if (xmlWarmup) {
    l.push('✔ Con el warmup (sonda 5) el portal devolvió el XML: alcanza con abrir la');
    l.push('  sesión en /consultas/ y no hace falta pegar nada del navegador.');
    l.push('  Corré el lote normal:  node tools/descargar-xml.js --entrada cdcs.txt');
    return l;
  }
  if (consultaSimple401 && consultaChromeOk) {
    l.push('→ El filtro del portal corta a los clientes que no parecen navegador');
    l.push('  (sonda 1 da 401/403 y la sonda 2 da 200). El descargador ya manda cabeceras de');
    l.push('  Chrome por defecto, así que volvé a probar sin --cliente-simple.');
  }
  var huboRechazo = [r.xmlSimple, r.xmlChrome, r.xmlWarmup, r.jsonChrome].some(function (x) {
    return x && (x.estado === 401 || x.estado === 403);
  });
  var pideCaptcha = /captcha/i.test((r.jsonChrome && r.jsonChrome.texto) || '');

  if (vacioSinSesion) {
    l.push('→ El portal responde 200 pero con la página vacía cuando la petición no trae la');
    l.push('  sesión de la consulta: el XML se sirve sólo dentro de la sesión que abre el');
    l.push('  navegador al consultar el CDC (captcha incluido). Un script suelto no la tiene.');
  } else if (huboRechazo) {
    l.push('→ El portal rechaza la descarga directa (401) cuando la petición no trae la sesión');
    l.push('  del navegador: la pantalla de consultas abre esa sesión al consultar el CDC.');
    l.push('  Un script suelto no la tiene, aunque mande cabeceras de Chrome.');
  } else {
    l.push('→ Ninguna sonda devolvió el XML. Mirá el detalle de arriba: el portal contestó');
    l.push('  algo distinto de lo esperado en todas las variantes.');
  }
  if (pideCaptcha) {
    l.push('  Además la consulta pide captcha (reCAPTCHA), así que la sesión sólo se puede abrir');
    l.push('  desde un navegador real.');
  }
  if (!haySesionImportada) {
    l.push('  Siguiente paso: repetí el diagnóstico con la sesión del navegador.');
    l.push('    1. En Chrome abrí ' + red.PAGINA_CONSULTA + ' y consultá el CDC con el captcha.');
    l.push('    2. F12 → pestaña Network → filtro "docs" → clic en la petición');
    l.push('       "documento-electronico-xml" → clic derecho → Copy → Copy as cURL.');
    l.push('    3. Guardá eso en captura-curl.txt y corré:');
    l.push('       node tools/diagnostico.js --entrada cdcs.txt --curl captura-curl.txt');
  } else {
    l.push('→ Ni con tu sesión del navegador el portal devolvió el XML para ese CDC.');
    l.push('  Probá con otro CDC, y si tampoco, el camino que queda es la extensión de Chrome');
    l.push('  (misma sesión, mismo navegador) o el WS de SIFEN con certificado CCFE.');
  }
  l.push('');
  l.push('  Estado: sonda 3/4 (GET sin sesión): ' + describir(r.xmlSimple) + ' / ' + describir(r.xmlChrome) + '.');
  l.push('          sonda 5 (con warmup): ' + describir(r.xmlWarmup) + '.');
  l.push('          sonda 6 (API JSON): ' + describir(r.jsonChrome) + '.');
  if (haySesionImportada) l.push('          sonda 7 (tu sesión): ' + describir(r.xmlImportada) + '.');
  return l;
}

function describir(r) {
  if (!r) return '-';
  if (r.estado === 'fallo') return 'error de red (' + red.recortar(r.error, 60) + ')';
  if (esXml(r)) return 'XML';
  return 'HTTP ' + r.estado + ' sin XML';
}

function montarInforme(base, cdcPrueba, cantidad, resultados, veredictoLineas) {
  var l = [];
  l.push('Diagnóstico de descarga de XML — e-Kuatia');
  l.push('Fecha: ' + new Date().toISOString());
  l.push('Node: ' + process.version + ' · ' + process.platform + ' ' + process.arch);
  l.push('Portal: ' + base);
  l.push('CDC de prueba: ' + cdcPrueba + ' (' + cantidad + ' en la lista)');
  l.push('');
  Object.keys(resultados).forEach(function (k) {
    var r = resultados[k];
    l.push(
      k +
        ': ' +
        (r && r.estado === 'fallo'
          ? 'error de red (' + red.recortar(r.error, 120) + ')'
          : 'HTTP ' + (r ? r.estado : '?') + ' → ' + clasificar(r && r.texto))
    );
  });
  l.push('');
  l.push('Veredicto:');
  veredictoLineas.forEach(function (x) {
    l.push('  ' + x);
  });
  return l.join('\n') + '\n';
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
