/* Helpers de red compartidos por los scripts de tools/ (sin dependencias).
 *
 * Por qué existe este archivo: el portal de e-Kuatia dejó de responder igual a
 * todos los clientes. Un cliente que no "parece navegador" puede recibir 401
 * antes de llegar a la aplicación, y la descarga del XML ahora depende de la
 * sesión (cookie) que el portal abre al consultar un CDC. Acá viven:
 *
 *   - las cabeceras de Chrome que usa el modo navegador (--navegador, default);
 *   - el manejo de cookies (jar simple);
 *   - el lector de "Copy as cURL" para reutilizar la sesión del navegador.
 */

'use strict';

var UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Cabeceras de un Chrome real pidiendo el XML desde la pantalla de consultas. */
var CABECERAS_NAVEGADOR = {
  'User-Agent': UA_CHROME,
  Accept: 'application/xml,text/xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-PY,es;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Referer: 'https://ekuatia.set.gov.py/consultas/',
};

var URL_PORTAL = 'https://ekuatia.set.gov.py';
var PAGINA_CONSULTA = URL_PORTAL + '/consultas/';
var ENDPOINT_XML = URL_PORTAL + '/docs/documento-electronico-xml/';
var ENDPOINT_JSON = URL_PORTAL + '/docs/documento-electronico';

/* ------------------------------- utilidades -------------------------------- */

function esperar(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

/** Primeros `n` caracteres del cuerpo, en una línea, para mostrar en consola. */
function recortar(texto, n) {
  if (texto == null) return '(sin cuerpo)';
  var muestra = String(texto).replace(/\s+/g, ' ').trim();
  if (!muestra) return '(vacío)';
  return muestra.length > (n || 300) ? muestra.slice(0, n || 300) + '…' : muestra;
}

/* ------------------------------- cabeceras --------------------------------- */

/** Cabeceras de navegador con `extra` encima (sin duplicar por mayúsculas). */
function cabeceras(extra) {
  var h = {};
  Object.keys(CABECERAS_NAVEGADOR).forEach(function (k) {
    h[k] = CABECERAS_NAVEGADOR[k];
  });
  Object.keys(extra || {}).forEach(function (k) {
    var igual = Object.keys(h).filter(function (n) {
      return n.toLowerCase() === k.toLowerCase();
    })[0];
    if (igual) delete h[igual];
    h[k] = extra[k];
  });
  return h;
}

/** Convierte ['User-Agent: X', ...] (--header) en un objeto. */
function headersDeLista(lista) {
  var h = {};
  (lista || []).forEach(function (crudo) {
    var i = String(crudo).indexOf(':');
    if (i > 0) h[crudo.slice(0, i).trim()] = crudo.slice(i + 1).trim();
  });
  return h;
}

/** Muestra las cabeceras enviadas, ocultando el valor de la cookie. */
function cabecerasVisibles(h) {
  var copia = {};
  Object.keys(h).forEach(function (k) {
    copia[k] = k.toLowerCase() === 'cookie' ? '(oculta, ' + h[k].split(';').length + ' cookie/s)' : h[k];
  });
  return copia;
}

/* -------------------------------- cookies ---------------------------------- */

/** Mete en el jar las cookies de una cadena "a=1; b=2" (o de un archivo). */
function parsearCookie(texto, jar) {
  String(texto || '')
    .split(/\r?\n|;/)
    .forEach(function (par) {
      var limpio = par.trim().replace(/^cookie:\s*/i, '');
      var i = limpio.indexOf('=');
      if (i > 0 && limpio.slice(0, i).indexOf(' ') === -1) {
        jar[limpio.slice(0, i).trim()] = limpio.slice(i + 1).trim();
      }
    });
  return jar;
}

/** Guarda en el jar las cookies que vengan en la respuesta (Set-Cookie). */
function cookiesDeRespuesta(resp, jar) {
  if (!resp || !resp.headers || !resp.headers.get) return jar;
  var crudas = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : resp.headers.get('set-cookie');
  var lista = Array.isArray(crudas) ? crudas : crudas ? [String(crudas)] : [];
  lista.forEach(function (c) {
    var par = String(c).split(';')[0];
    var i = par.indexOf('=');
    if (i > 0) jar[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  });
  return jar;
}

/** Cabecera Cookie a partir del jar (o null si está vacío). */
function cabeceraCookie(jar) {
  var nombres = Object.keys(jar || {});
  if (!nombres.length) return null;
  return nombres
    .map(function (n) {
      return n + '=' + jar[n];
    })
    .join('; ');
}

function nombresDeJar(jar) {
  var nombres = Object.keys(jar || {});
  return nombres.length ? nombres.join(', ') : 'ninguna';
}

/* --------------------------- "Copy as cURL" -------------------------------- */

/**
 * Lee el texto de un "Copy as cURL" de Chrome y devuelve
 * {url, headers, cookie, metodo, cuerpo}. Acepta las variantes de bash y de
 * cmd (^" ... ^") y también una simple línea de `curl -H ... URL`.
 */
function parsearCurl(texto) {
  var s = String(texto == null ? '' : texto)
    .replace(/\r?\n/g, ' ')
    .replace(/\^\"/g, '"')
    .replace(/\^/g, '');

  var salida = { url: null, headers: {}, cookie: null, metodo: null, cuerpo: null };

  // Quita los -H/--header/-b/--cookie/... junto con su valor, guardando el dato.
  var reFlag = /(--header|-H|--cookie|-b|--url|--request|-X|--data-raw|--data-binary|--data)\s+("([^"]*)"|'([^']*)'|(\S+))/g;
  var m;
  while ((m = reFlag.exec(s))) {
    var bandera = m[1];
    var valor = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5];
    if (bandera === '--url') salida.url = valor;
    else if (bandera === '-b' || bandera === '--cookie') salida.cookie = valor;
    else if (bandera === '-X' || bandera === '--request') salida.metodo = valor.toUpperCase();
    else if (bandera.indexOf('--data') === 0) salida.cuerpo = valor;
    else {
      var i = valor.indexOf(':');
      if (i > 0) salida.headers[valor.slice(0, i).trim()] = valor.slice(i + 1).trim();
    }
  }

  if (!salida.url) {
    var sinFlags = s.replace(reFlag, ' ');
    var mUrl = sinFlags.match(/https?:\/\/[^\s'"]+/);
    if (mUrl) salida.url = mUrl[0];
  }

  if (salida.headers.Cookie || salida.headers.cookie) {
    salida.cookie = salida.headers.Cookie || salida.headers.cookie;
    delete salida.headers.Cookie;
    delete salida.headers.cookie;
  }

  return salida;
}

/* --------------------------------- URLs ------------------------------------ */

/**
 * URL base del portal. Se puede pisar con --base-url o con la variable de
 * entorno EKUA_BASE, que es lo que usan las pruebas locales con un servidor
 * falso (ver tools/pruebas/mock-ekuatia.js).
 */
function base(opts) {
  var b = (opts && opts.base) || process.env.EKUA_BASE || URL_PORTAL;
  return String(b).replace(/\/+$/, '');
}

function paginaConsulta(opts) {
  return base(opts) + '/consultas/';
}

function endpointXml(opts) {
  return base(opts) + '/docs/documento-electronico-xml/';
}

function endpointJson(opts) {
  return base(opts) + '/docs/documento-electronico';
}

module.exports = {
  UA_CHROME: UA_CHROME,
  CABECERAS_NAVEGADOR: CABECERAS_NAVEGADOR,
  URL_PORTAL: URL_PORTAL,
  PAGINA_CONSULTA: PAGINA_CONSULTA,
  ENDPOINT_XML: ENDPOINT_XML,
  ENDPOINT_JSON: ENDPOINT_JSON,
  esperar: esperar,
  recortar: recortar,
  cabeceras: cabeceras,
  headersDeLista: headersDeLista,
  cabecerasVisibles: cabecerasVisibles,
  parsearCookie: parsearCookie,
  cookiesDeRespuesta: cookiesDeRespuesta,
  cabeceraCookie: cabeceraCookie,
  nombresDeJar: nombresDeJar,
  parsearCurl: parsearCurl,
  base: base,
  paginaConsulta: paginaConsulta,
  endpointXml: endpointXml,
  endpointJson: endpointJson,
};
