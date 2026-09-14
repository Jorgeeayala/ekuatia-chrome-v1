#!/usr/bin/env node
/* Descarga el XML de los comprobantes electrónicos (DTE) desde e-Kuatia.
 *
 * Uso:
 *   node tools/descargar-xml.js 01800975120007008007180822026080217723517894
 *   node tools/descargar-xml.js --entrada cdcs.txt
 *   node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --debug
 *   node tools/descargar-xml.js --entrada cdcs.txt --curl captura-curl.txt
 *
 * Contexto (importante desde el 401):
 *   - El endpoint /docs/documento-electronico-xml/<CDC> ya NO es anónimo: la
 *     pantalla de consultas lo usa con la sesión (cookie) que el portal abre al
 *     consultar el CDC. Ante un cliente sin sesión responde 401.
 *   - Por eso este script manda las cabeceras de un Chrome real y, si recibe
 *     401, abre la sesión en /consultas/ y reintenta una vez.
 *   - Si aun así da 401, se copia una petición del navegador con
 *     "Copy as cURL" y se pasa con --curl (o --cookie). Ver DESCARGA-XML.md.
 *   - Ante un CDC que no existe, no está aprobado o fue inutilizado, el
 *     servidor responde 200 con un HTML vacío. Por eso la respuesta se valida
 *     antes de guardar: nunca se escribe un .xml vacío.
 *   - Sin dependencias (usa el fetch de Node 18+).
 */

'use strict';

var fs = require('fs');
var path = require('path');
var cdc = require('../src/cdc.js');
var red = require('./red.js');

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
    navegador: true,
    warmup: true,
    api: false,
    base: null,
    curl: null,
    cookie: null,
    segundaPasada: true,
    pausaFallo: 10000,
    headers: [],
    cdcs: [],
  };

  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--entrada' || a === '-i') opts.entrada = argv[++i];
    else if (a === '--salida' || a === '-o') opts.salida = argv[++i];
    else if (a === '--pausa') opts.pausa = Number(argv[++i]);
    else if (a === '--pausa-fallo') opts.pausaFallo = Number(argv[++i]);
    else if (a === '--sin-segunda-pasada') opts.segundaPasada = false;
    else if (a === '--reintentos') opts.reintentos = Number(argv[++i]);
    else if (a === '--nombre-largo') opts.nombreCorto = false;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--navegador') opts.navegador = true;
    else if (a === '--cliente-simple') opts.navegador = false;
    else if (a === '--warmup') opts.warmup = true;
    else if (a === '--sin-warmup') opts.warmup = false;
    else if (a === '--api') opts.api = true;
    else if (a === '--base-url') opts.base = argv[++i];
    else if (a === '--curl') opts.curl = argv[++i];
    else if (a === '--cookie') opts.cookie = argv[++i];
    else if (a === '--cookie-archivo') opts.cookie = '@' + argv[++i];
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
      '  --entrada, -i     archivo con un CDC por línea (acepta espacios, puntos o guiones)',
      '  --salida,  -o     carpeta de destino (por defecto: ./xml)',
      '  --pausa           milisegundos entre descargas (por defecto: 1200)',
      '  --pausa-fallo     espera antes de reintentar los que fallaron (por defecto: 10000)',
      '  --sin-segunda-pasada  no reintenta al final los CDC que quedaron con 401/red',
      '  --reintentos      reintentos ante errores de red, 5xx y 429 (por defecto: 3)',
      '  --nombre-largo    nombra el archivo como AAAA-MM-DD_RUC-numero_CDC.xml',
      '  --debug           muestra estado, cabeceras y un trozo de la respuesta',
      '',
      '  Sesión y cabeceras (lo que destraba los 401):',
      '  --navegador       manda cabeceras de Chrome (por defecto)',
      '  --cliente-simple  manda sólo Accept, como antes, para comparar',
      '  --sin-warmup      no intenta abrir la sesión en /consultas/ ante un 401',
      '  --cookie       X  cookie de sesión, p.ej. -H "JSESSIONID=ABC" o "NOMBRE=valor; OTRA=valor"',
      '  --cookie-archivo  un archivo con la cookie (o pegar el "Copy as cURL" completo)',
      '  --curl AR         pega acá (o en un archivo) el "Copy as cURL" de Chrome; reutiliza',
      '                    sus cabeceras y su cookie de sesión',
      '  --header, -H      cabecera extra, repetible: -H "User-Agent: Mozilla/5.0 ..."',
      '  --api             además del GET, prueba la API JSON /docs/documento-electronico',
      '  --base-url        portal alternativo (para pruebas; también EKUA_BASE)',
      '',
      'Deja en la carpeta de salida:',
      '  <CDC>.xml                 los XML descargados',
      '  no_encontrados.txt        CDC válidos sin XML (inexistente, rechazado, inutilizado)',
      '  no_validos.txt            líneas que no son un CDC de 44 dígitos con DV correcto',
      '  resumen.csv               CDC, estado, bytes y archivo',
      '',
      'Si todo da 401, el siguiente paso es el diagnóstico:',
      '  node tools/diagnostico.js --entrada cdcs.txt',
    ].join('\n')
  );
}

/* ------------------------------ sesión (jar) ------------------------------- */

/** Arma el contexto de una corrida: jar de cookies + estado del warmup. */
function nuevoContexto(opts) {
  var jar = {};
  var ctx = { jar: jar, warmupHecho: false, apiDescartada: false, textos: {}, headers: {} };

  // Cabeceras: las del navegador (o sólo Accept) + --curl + --header.
  if (opts.navegador) ctx.headers = red.cabeceras({});
  else ctx.headers = { Accept: 'application/xml' };

  if (opts.curl) {
    var crudo = opts.curl;
    // Si es una ruta a un archivo, se lee; si no, se toma como texto pegado.
    if (fs.existsSync(crudo)) crudo = fs.readFileSync(crudo, 'utf8');
    var captura = red.parsearCurl(crudo);
    if (!captura.url && !captura.cookie && !Object.keys(captura.headers).length) {
      console.log('· no pude leer la captura de --curl: "' + opts.curl + '".');
      console.log('  Revisá que sea el "Copy as cURL" completo y que el archivo se llame');
      console.log('  captura-curl.txt (ojo con el Bloc de notas, que a veces agrega .txt de nuevo).');
    }
    Object.keys(captura.headers).forEach(function (k) {
      ctx.headers[k] = captura.headers[k];
    });
    if (captura.cookie) red.parsearCookie(captura.cookie, jar);
    ctx.captura = captura;
  }

  if (opts.cookie) {
    if (opts.cookie.charAt(0) === '@') {
      var ruta = opts.cookie.slice(1);
      red.parsearCookie(fs.readFileSync(ruta, 'utf8'), jar);
    } else {
      red.parsearCookie(opts.cookie, jar);
    }
  }

  var extras = red.headersDeLista(opts.headers);
  Object.keys(extras).forEach(function (k) {
    ctx.headers[k] = extras[k];
  });

  return ctx;
}

/** Devuelve las cabeceras de la petición, con la cookie del jar si hay. */
function headersDePeticion(ctx, extra) {
  var h = {};
  Object.keys(ctx.headers).forEach(function (k) {
    h[k] = ctx.headers[k];
  });
  Object.keys(extra || {}).forEach(function (k) {
    h[k] = extra[k];
  });
  var cookie = red.cabeceraCookie(ctx.jar);
  if (cookie) h.Cookie = cookie;
  return h;
}

/** Visita /consultas/ para que el portal nos dé su cookie de sesión. */
async function abrirSesion(ctx, opts) {
  if (ctx.warmupHecho) return false;
  ctx.warmupHecho = true;

  var headers = headersDePeticion(ctx, { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
  delete headers['Sec-Fetch-Dest'];
  headers['Sec-Fetch-Dest'] = 'document';
  headers['Sec-Fetch-Mode'] = 'navigate';
  headers['Sec-Fetch-Site'] = 'none';
  delete headers.Referer;

  try {
    var resp = await fetch(red.paginaConsulta(opts), { headers: headers, redirect: 'follow' });
    red.cookiesDeRespuesta(resp, ctx.jar);
    console.log(
      '· sesión abierta en /consultas/ → HTTP ' +
        resp.status +
        ' · cookies: ' +
        red.nombresDeJar(ctx.jar)
    );
    return true;
  } catch (err) {
    console.log('· no se pudo abrir sesión: ' + (err && err.message ? err.message : err));
    return false;
  }
}

/* ------------------------------- debug ------------------------------------- */

function depurarPeticion(headers, opts) {
  if (!opts.debug) return;
  console.log('    [debug] cabeceras: ' + JSON.stringify(red.cabecerasVisibles(headers)));
}

/** Muestra todo lo que el servidor contestó, para diagnosticar. */
function depurar(etiqueta, resp, texto, opts) {
  if (!opts.debug) return;
  var lineas = ['    [debug] ' + etiqueta + ' HTTP ' + resp.status];

  function cabecera(nombre) {
    var v = resp.headers && resp.headers.get ? resp.headers.get(nombre) : null;
    if (v) lineas.push(nombre + ': ' + v);
  }
  cabecera('content-type');
  cabecera('www-authenticate');
  cabecera('server');
  cabecera('set-cookie');

  if (texto != null) lineas.push('cuerpo: ' + red.recortar(texto, 300));
  console.log(lineas.join('\n             '));
}

/* ------------------------------- guardado ---------------------------------- */

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

function guardarXml(cdcLimpio, texto, opts) {
  var analisis = cdc.analizarCdc(cdcLimpio);
  var archivo = path.join(opts.salida, nombreArchivo(analisis, opts.nombreCorto));
  fs.writeFileSync(archivo, texto, 'utf8');
  return { estado: 'descargado', bytes: Buffer.byteLength(texto, 'utf8'), archivo: archivo };
}

/* ---------------------------- API JSON (opcional) -------------------------- */

/** Busca el XML dentro de la respuesta JSON de /docs/documento-electronico. */
function xmlEnJson(texto) {
  var datos;
  try {
    datos = JSON.parse(texto);
  } catch (e) {
    return null;
  }
  var candidatos = [
    datos && datos.xml,
    datos && datos.DE && datos.DE.xml,
    datos && datos.DE && datos.DE.XML,
    datos && typeof datos.DE === 'string' ? datos.DE : null,
  ];
  for (var i = 0; i < candidatos.length; i++) {
    if (typeof candidatos[i] === 'string' && RE_XML.test(candidatos[i])) return candidatos[i];
  }
  var mensaje = datos && (datos.mensaje || datos.message || datos.error);
  return mensaje ? { mensaje: mensaje } : null;
}

/**
 * Prueba POST /docs/documento-electronico {cdc, captcha}. Si el portal contesta
 * con el XML, se guarda; si contesta con un motivo (captcha, sesión), se anota.
 */
async function intentarApi(cdcLimpio, opts, ctx) {
  var url = red.endpointJson(opts);
  var headers = headersDePeticion(ctx, {
    'Content-Type': 'application/json',
    Accept: 'application/json, */*',
  });

  depurarPeticion(headers, opts);
  var resp = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ cdc: cdcLimpio, captcha: '' }),
    redirect: 'follow',
  });
  red.cookiesDeRespuesta(resp, ctx.jar);

  var texto = await resp.text();
  depurar('API JSON', resp, texto, opts);

  if (!resp.ok) return { estado: 'error', detalle: 'HTTP ' + resp.status + ' (API JSON)' };

  var encontrado = xmlEnJson(texto);
  if (encontrado && typeof encontrado === 'string') {
    return guardarXml(cdcLimpio, encontrado, opts);
  }
  if (encontrado && encontrado.mensaje) ctx.apiMotivo = encontrado.mensaje;
  else ctx.apiMotivo = 'la respuesta no traía el XML';
  return null; // se sigue con el GET, que es el camino normal
}

/* -------------------------------- descarga --------------------------------- */

async function descargarUno(cdcLimpio, opts, ctx) {
  if (opts.api && !ctx.apiDescartada) {
    try {
      var porApi = await intentarApi(cdcLimpio, opts, ctx);
      if (porApi) return porApi;
      ctx.apiDescartada = true;
      if (opts.debug) console.log('    [debug] la API JSON no sirvió: ' + ctx.apiMotivo);
    } catch (err) {
      ctx.apiDescartada = true;
      if (opts.debug) console.log('    [debug] la API JSON falló: ' + err.message);
    }
  }

  var url = red.endpointXml(opts) + cdcLimpio;
  var ultimoError = null;

  for (var intento = 1; intento <= opts.reintentos; intento++) {
    try {
      var headers = headersDePeticion(ctx);
      depurarPeticion(headers, opts);
      var resp = await fetch(url, { headers: headers, redirect: 'follow' });
      red.cookiesDeRespuesta(resp, ctx.jar);

      // 5xx y 429 se reintentan con backoff; el resto se resuelve acá.
      if (resp.status >= 500 || resp.status === 429) {
        ultimoError = 'HTTP ' + resp.status;
        depurar('reintento ' + intento, resp, null, opts);
        await red.esperar(1000 * Math.pow(2, intento - 1));
        continue;
      }

      var texto = await resp.text();

      // 401/403: o falta la sesión, o el portal nos está frenando antes de
      // llegar a la aplicación (el sitio está detrás de un WAF F5/Dynatrace,
      // y el rechazo suele ser temporal). Se abre sesión una vez, y si vuelve
      // a pasar se espera más y se reintenta antes de darlo por perdido.
      if (resp.status === 401 || resp.status === 403) {
        depurar('rechazo', resp, texto, opts);
        if (opts.warmup && !ctx.warmupHecho) {
          await abrirSesion(ctx, opts);
          continue;
        }
        if (intento < opts.reintentos) {
          var esperaFreno = 3000 * intento;
          console.log(
            '· HTTP ' + resp.status + ': puede ser un freno temporal del portal; ' +
              'reintento en ' + esperaFreno / 1000 + ' s…'
          );
          await red.esperar(esperaFreno);
          continue;
        }
        return {
          estado: 'error',
          detalle: 'HTTP ' + resp.status + ' (sesión o freno del portal)',
          motivo: red.recortar(texto, 200),
        };
      }

      if (!resp.ok) {
        depurar('rechazo', resp, texto, opts);
        return { estado: 'error', detalle: 'HTTP ' + resp.status, motivo: red.recortar(texto, 200) };
      }

      if (!RE_XML.test(texto)) {
        depurar('no es XML', resp, texto, opts);
        return { estado: 'no-encontrado', detalle: 'sin XML público' };
      }

      return guardarXml(cdcLimpio, texto, opts);
    } catch (err) {
      ultimoError = err && err.message ? err.message : String(err);
      if (opts.debug) console.log('    [debug] excepción: ' + ultimoError);
      await red.esperar(1000 * Math.pow(2, intento - 1));
    }
  }

  return { estado: 'error', detalle: ultimoError || 'sin detalle' };
}

/* ---------------------------------- main ----------------------------------- */

function leerCdcs(opts) {
  var lineas = [];
  if (opts.entrada) {
    lineas = fs.readFileSync(opts.entrada, 'utf8').split(/\r?\n/);
  }
  return lineas.concat(opts.cdcs);
}

async function main() {
  var opts = parsearArgumentos(process.argv);
  if (opts.ayuda) return ayuda();

  var lineas = leerCdcs(opts);
  if (!lineas.length) return ayuda();

  fs.mkdirSync(opts.salida, { recursive: true });

  var ctx = nuevoContexto(opts);
  if (Object.keys(ctx.jar).length) {
    console.log('· sesión importada · cookies: ' + red.nombresDeJar(ctx.jar));
  }
  if (opts.navegador && opts.debug) {
    console.log('· cliente: navegador (cabeceras de Chrome). Con --cliente-simple, sólo Accept.');
  }
  if (opts.warmup && !Object.keys(ctx.jar).length) await abrirSesion(ctx, opts);

  var filas = []; // { cdc, estado, bytes, archivo, detalle }
  var indice = Object.create(null);
  var vistos = Object.create(null);

  /** Anota el resultado de un CDC (o lo reemplaza si ya estaba anotado). */
  function anotar(fila, prefijo) {
    if (indice[fila.cdc]) filas[indice[fila.cdc] - 1] = fila;
    else {
      filas.push(fila);
      indice[fila.cdc] = filas.length;
    }
    if (prefijo !== false) imprimir(fila, prefijo);
  }

  function imprimir(fila, prefijo) {
    if (fila.estado === 'descargado') {
      console.log('✓ ' + fila.cdc + '  ' + (fila.bytes / 1024).toFixed(1) + ' KB  →  ' + fila.archivo);
    } else if (fila.estado === 'no-encontrado') {
      console.log('· ' + fila.cdc + '  sin XML público');
    } else if (fila.estado === 'no-valido') {
      console.log('✗ no válido     ' + fila.detalle);
    } else {
      console.log((prefijo || '! ') + fila.cdc + '  error: ' + (fila.detalle || ''));
    }
  }

  /* ------------------------------ primera pasada --------------------------- */

  for (var i = 0; i < lineas.length; i++) {
    var linea = lineas[i].trim();
    if (!linea) continue;

    var cdcLimpio = cdc.extraerCdc(linea);
    if (!cdcLimpio || !cdc.validarCdc(cdcLimpio)) {
      anotar({ cdc: linea, estado: 'no-valido', bytes: 0, archivo: '', detalle: linea });
      continue;
    }
    if (vistos[cdcLimpio]) continue;
    vistos[cdcLimpio] = true;

    var r = await descargarUno(cdcLimpio, opts, ctx);
    anotar({
      cdc: cdcLimpio,
      estado: r.estado,
      bytes: r.bytes || 0,
      archivo: r.archivo || '',
      detalle: r.detalle || '',
    });
    if (opts.debug && r.motivo) console.log('    [debug] el servidor dijo: ' + r.motivo);

    if (i < lineas.length - 1) await red.esperar(opts.pausa);
  }

  /* ------------------------------ segunda pasada --------------------------- */

  // El portal (detrás de un WAF) rechaza de a ráfagas: 401/403/5xx que después
  // pasan solos. Antes de dar por perdido un CDC se espera un poco y se
  // reintenta una vez más, sólo para los que fallaron.
  var transitorios = filas.filter(function (f) {
    return f.estado === 'error' && /^(HTTP 40[13]|HTTP 5\d\d|HTTP 429|fetch failed|.*socket.*|.*ECONN|.*ETIMEDOUT)/i.test(f.detalle || '');
  });

  if (transitorios.length && opts.segundaPasada) {
    console.log('');
    console.log(
      '· ' + transitorios.length + ' CDC quedaron con error transitorio (401/red). ' +
        'Espero ' + Math.round(opts.pausaFallo / 1000) + ' s y los reintento una vez…'
    );
    await red.esperar(opts.pausaFallo);

    for (var j = 0; j < transitorios.length; j++) {
      var cdcRe = transitorios[j].cdc;
      var rr = await descargarUno(cdcRe, opts, ctx);
      anotar(
        {
          cdc: cdcRe,
          estado: rr.estado,
          bytes: rr.bytes || 0,
          archivo: rr.archivo || '',
          detalle: rr.detalle || '',
        },
        '  (2ª pasada) '
      );
      if (opts.debug && rr.motivo) console.log('    [debug] el servidor dijo: ' + rr.motivo);
      if (j < transitorios.length - 1) await red.esperar(opts.pausa);
    }
  }

  /* --------------------------------- salida -------------------------------- */

  var totales = { descargado: 0, 'no-encontrado': 0, error: 0, 'no-valido': 0 };
  var noEncontrados = [];
  var noValidos = [];
  var conFreno = 0;

  filas.forEach(function (f) {
    totales[f.estado] = (totales[f.estado] || 0) + 1;
    if (f.estado === 'no-encontrado') noEncontrados.push(f.cdc);
    if (f.estado === 'no-valido') noValidos.push(f.detalle);
    if (f.estado === 'error' && /HTTP 40[13]/.test(f.detalle || '')) conFreno++;
  });

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
        filas.map(function (fila) {
          return [fila.cdc, fila.estado, fila.bytes, '"' + String(fila.archivo || fila.detalle || '').replace(/"/g, '""') + '"'].join(
            ','
          );
        })
      )
      .join('\n') + '\n',
    'utf8'
  );

  console.log('');
  console.log(
    'Descargados: ' + totales.descargado + ' | sin XML público: ' + totales['no-encontrado'] +
      ' | con error: ' + (totales.error || 0) + ' | no válidos: ' + totales['no-valido']
  );

  if (conFreno) {
    console.log('');
    console.log(
      'Aviso: ' + conFreno + ' CDC siguen con 401 después de reintentar. Es el portal frenando por\n' +
        'rato (WAF), no un problema de tus comprobantes: esperá un minuto y volvé a correr\n' +
        'el mismo comando (los ya descargados se vuelven a pedir sin problema), o probá con\n' +
        'más aire entre pedidos:\n' +
        '  node tools/descargar-xml.js --entrada ' + (opts.entrada || 'cdcs.txt') +
        ' --salida ' + opts.salida + ' --pausa 5000'
    );
  }

  console.log('Carpeta: ' + path.resolve(opts.salida));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
