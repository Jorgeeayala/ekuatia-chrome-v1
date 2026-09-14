/* Service worker — "Descargar XML de e-Kuatia".
 *
 * Flujo único y directo:
 *
 *   CDC (selección, atajo o popup)
 *     └─► validar: 44 dígitos + dígito verificador módulo 11
 *          └─► GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>
 *               └─► ¿la respuesta es XML?  sí → guardar en Descargas/e-Kuatia/xml/
 *                                           no → marcar "sin XML público"
 *
 * Ojo: desde 2026 el endpoint ya no es anónimo. El XML viaja con la sesión que
 * el portal abre al consultar el CDC, y sin esa sesión contesta 401. Por eso
 * las peticiones van con credentials:'include' (usan las cookies del navegador):
 * la extensión corre donde está la sesión. Igual conviene consultar el CDC una
 * vez en la pantalla de consultas. Cuando el CDC no tiene XML público
 * (inexistente, rechazado o inutilizado) responde 200 con un HTML vacío, así
 * que la respuesta se valida antes de grabar. Ver DESCARGA-XML.md.
 */

importScripts('src/cdc.js');

var URL_XML = 'https://ekuatia.set.gov.py/docs/documento-electronico-xml/';
var URL_CONSULTA = 'https://ekuatia.set.gov.py/consultas/';
var CARPETA_XML = 'e-Kuatia/xml';
var PAUSA_DESCARGA_MS = 1200;
var MAX_BANDEJA = 500;
var RE_XML = /^\s*(<\?xml|<rde|<rDE)/i;

/**
 * Qué decir cuando el portal rechaza la descarga.
 *
 * Desde mediados de 2026 el endpoint del XML dejó de ser anónimo: contesta 401
 * cuando la petición no trae la sesión que el propio portal abre al consultar
 * el CDC (con captcha). La extensión va por el camino bueno —el navegador, con
 * sus cookies—, pero la sesión tiene que estar abierta.
 */
var MOTIVO_SESION =
  'HTTP 401 · el portal exige su sesión: abrí ' +
  URL_CONSULTA +
  ' y consultá ese CDC (con captcha); recién ahí el XML se puede descargar';

/* ------------------------------- bandeja ---------------------------------- */

async function bandejaLeer() {
  var datos = await chrome.storage.local.get('bandeja');
  return Array.isArray(datos.bandeja) ? datos.bandeja : [];
}

async function bandejaGuardar(bandeja) {
  if (bandeja.length > MAX_BANDEJA) bandeja = bandeja.slice(-MAX_BANDEJA);
  await chrome.storage.local.set({ bandeja: bandeja });
}

/** Agrega o actualiza un CDC, conservando el estado de descarga previo. */
async function bandejaAgregar(cdcLimpio, extra) {
  var bandeja = await bandejaLeer();
  var idx = -1;
  for (var i = 0; i < bandeja.length; i++) {
    if (bandeja[i].cdc === cdcLimpio) idx = i;
  }

  var entrada = idx !== -1 ? bandeja[idx] : { cdc: cdcLimpio, ts: Date.now() };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) entrada[k] = extra[k];
    }
  }

  if (idx !== -1) bandeja[idx] = entrada;
  else bandeja.push(entrada);

  await bandejaGuardar(bandeja);
  return bandeja;
}

async function bandejaMarcar(cdcLimpio, estadoXml, motivo) {
  var bandeja = await bandejaLeer();
  for (var i = 0; i < bandeja.length; i++) {
    if (bandeja[i].cdc === cdcLimpio) {
      bandeja[i].xml = estadoXml;
      bandeja[i].xmlTs = Date.now();
      bandeja[i].xmlMotivo = motivo || '';
    }
  }
  await bandejaGuardar(bandeja);
}

/* -------------------------------- badge ----------------------------------- */

function marcar(tabId, texto, color, titulo) {
  try {
    if (tabId != null) {
      chrome.action.setBadgeText({ tabId: tabId, text: texto });
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
      chrome.action.setTitle({ tabId: tabId, title: titulo });
    }
  } catch (e) {
    /* la pestaña pudo cerrarse entre una llamada y la otra */
  }
}

/* --------------------------- descarga del XML ------------------------------ */

/** Espera a que una pestaña termine de cargar (o se vence el plazo). */
function esperarCarga(tabId, ms) {
  return new Promise(function (resolver) {
    var terminado = false;
    function terminar(ok) {
      if (terminado) return;
      terminado = true;
      chrome.tabs.onUpdated.removeListener(escuchar);
      clearTimeout(temporizador);
      resolver(ok);
    }
    function escuchar(id, info) {
      if (id === tabId && info.status === 'complete') terminar(true);
    }
    var temporizador = setTimeout(function () {
      terminar(false);
    }, ms || 8000);
    chrome.tabs.onUpdated.addListener(escuchar);
  });
}

/**
 * Pide el XML desde la propia página del portal (content script).
 *
 * Es el plan B del fetch del service worker: ahí la petición sale con el origen
 * de ekuatia.set.gov.py, así que la cookie de sesión viaja siempre, sin las
 * restricciones de SameSite que puede aplicar el navegador a una petición
 * hecha desde la extensión. Si no hay ninguna pestaña del portal abierta, se
 * abre una en segundo plano y se cierra al terminar.
 */
async function pedirXmlDesdeLaPagina(cdcLimpio) {
  var pestañas = [];
  try {
    pestañas = await chrome.tabs.query({ url: 'https://ekuatia.set.gov.py/*' });
  } catch (err) {
    pestañas = [];
  }

  var pestaña = null;
  for (var i = 0; i < pestañas.length; i++) {
    if (/\/consultas\/?$/.test(pestañas[i].url || '') || /\/consultas\//.test(pestañas[i].url || '')) {
      pestaña = pestañas[i];
    }
  }
  if (!pestaña && pestañas.length) pestaña = pestañas[0];

  var creada = false;
  if (!pestaña) {
    pestaña = await chrome.tabs.create({ url: URL_CONSULTA + cdcLimpio, active: false });
    creada = true;
    await esperarCarga(pestaña.id, 10000);
  }

  var salida = { estado: 0, texto: '' };
  try {
    var ejecucion = await chrome.scripting.executeScript({
      target: { tabId: pestaña.id },
      func: function (url) {
        return fetch(url, { credentials: 'include' })
          .then(function (r) {
            return r.text().then(function (t) {
              return { estado: r.status, texto: t };
            });
          })
          .catch(function (e) {
            return { estado: 0, texto: String(e && e.message ? e.message : e) };
          });
      },
      args: [URL_XML + cdcLimpio],
    });
    if (ejecucion && ejecucion[0] && ejecucion[0].result) salida = ejecucion[0].result;
  } catch (err) {
    salida.texto = err && err.message ? err.message : String(err);
  } finally {
    if (creada) {
      try {
        await chrome.tabs.remove(pestaña.id);
      } catch (err) {
        /* la pestaña ya no está: no importa */
      }
    }
  }
  return salida;
}

/**
 * Pide el XML y comprueba que realmente lo sea: el servidor responde 200 con
 * un HTML vacío cuando el CDC no tiene XML público.
 *
 * `credentials: 'include'` es lo que hace que viaje la cookie de sesión del
 * navegador: sin ella el portal contesta 401 (ver MOTIVO_SESION). Si aun así
 * contesta 401, se reintenta desde la página del portal.
 */
async function verificarXml(cdcLimpio) {
  var resp = await fetch(URL_XML + cdcLimpio, {
    method: 'GET',
    headers: { Accept: 'application/xml,text/xml,*/*;q=0.8', 'Accept-Language': 'es-PY,es;q=0.9' },
    credentials: 'include',
    redirect: 'follow',
  });

  if (resp.status === 401 || resp.status === 403) {
    var desde = await pedirXmlDesdeLaPagina(cdcLimpio);
    if (desde.estado === 200 && RE_XML.test(desde.texto)) {
      return { ok: true, bytes: desde.texto.length, texto: desde.texto, desdeLaPagina: true };
    }
    if (desde.estado === 200) {
      return { ok: false, motivo: 'sin XML público (inexistente, rechazado o inutilizado)' };
    }
    return { ok: false, sesion: true, motivo: MOTIVO_SESION };
  }
  if (!resp.ok) return { ok: false, motivo: 'HTTP ' + resp.status };

  var texto = await resp.text();
  if (!RE_XML.test(texto)) {
    return { ok: false, motivo: 'sin XML público (inexistente, rechazado o inutilizado)' };
  }
  return { ok: true, bytes: texto.length, texto: texto };
}

/** Hasta qué tamaño conviene guardar el texto ya validado (en vez de re-pedirlo). */
var LIMITE_TEXTO_DIRECTO = 512 * 1024;

/**
 * Guarda en Descargas el XML que YA validamos.
 *
 * Guardar el texto que trajimos (en lugar de pedir la URL otra vez) evita dos
 * cosas: que la segunda petición reciba el 401 del WAF y guarde la página de
 * error, y que quede en disco algo distinto de lo que se verificó. Si el
 * navegador rechazara la descarga del texto, se cae a bajarlo por URL.
 */
async function guardarXml(cdcLimpio, texto) {
  var nombre = CARPETA_XML + '/' + cdcLimpio + '.xml';

  if (texto && texto.length <= LIMITE_TEXTO_DIRECTO) {
    try {
      return await chrome.downloads.download({
        url: 'data:application/xml;charset=utf-8,' + encodeURIComponent(texto),
        filename: nombre,
        conflictAction: 'overwrite',
        saveAs: false,
      });
    } catch (err) {
      /* se intenta por URL, más abajo */
    }
  }

  return chrome.downloads.download({
    url: URL_XML + cdcLimpio,
    filename: nombre,
    conflictAction: 'overwrite',
    saveAs: false,
  });
}

/** Descarga el XML de un CDC a la carpeta e-Kuatia/xml/. */
async function descargarXml(cdcLimpio) {
  try {
    var ver = await verificarXml(cdcLimpio);

    if (!ver.ok) {
      await bandejaMarcar(cdcLimpio, ver.sesion ? 'error' : 'no-encontrado', ver.motivo);
      if (ver.sesion) await anotarError('descarga rechazada por el portal', ver.motivo, cdcLimpio);
      return { ok: false, cdc: cdcLimpio, motivo: ver.motivo, sesion: !!ver.sesion };
    }

    var id = await guardarXml(cdcLimpio, ver.texto);

    await bandejaMarcar(cdcLimpio, 'descargado');
    return { ok: true, cdc: cdcLimpio, downloadId: id, bytes: ver.bytes };
  } catch (err) {
    await anotarError('descargar ' + cdcLimpio, err);
    try {
      await bandejaMarcar(cdcLimpio, 'error', 'No se pudo: ' + (err.message || err));
    } catch (e) {
      /* nada más que hacer */
    }
    return { ok: false, cdc: cdcLimpio, motivo: 'No se pudo: ' + (err.message || err) };
  }
}

/* ------------------------------ diagnóstico -------------------------------- */

/** Deja anotado el último error, para poder verlo desde el popup. */
async function anotarError(donde, err, extra) {
  var texto = (err && err.stack) || (err && err.message) || String(err);
  try {
    await chrome.storage.local.set({
      ultimoError: { donde: donde, texto: String(texto), ts: Date.now(), extra: extra || '' },
    });
  } catch (e) {
    /* si ni el storage responde, no hay nada que hacer */
  }
}

/**
 * Junta todo lo que permite saber por qué algo no anda, sin abrir DevTools:
 * versión, tamaño de la bandeja, si el portal responde, cuántas pestañas del
 * portal hay abiertas, cómo salieron las últimas descargas de Chrome y el
 * último error guardado.
 */
async function diagnostico() {
  var informe = {
    version: '?',
    bandeja: 0,
    portal: '',
    pestanasPortal: 0,
    descargas: [],
    ultimoError: null,
  };

  try {
    informe.version = chrome.runtime.getManifest().version;
  } catch (e) {
    informe.version = 'error: ' + (e.message || e);
  }

  try {
    var datos = await chrome.storage.local.get(['bandeja', 'ultimoError']);
    informe.bandeja = Array.isArray(datos.bandeja) ? datos.bandeja.length : 0;
    informe.ultimoError = datos.ultimoError || null;
  } catch (e) {
    informe.storage = 'error: ' + (e.message || e);
  }

  try {
    var pestanas = await chrome.tabs.query({ url: URL_CONSULTA + '*' });
    informe.pestanasPortal = pestanas.length;
  } catch (e) {
    informe.pestanasPortal = 'error: ' + (e.message || e);
  }

  try {
    var resp = await fetch(URL_CONSULTA, { credentials: 'include', redirect: 'follow' });
    informe.portal = 'HTTP ' + resp.status;
  } catch (e) {
    informe.portal = 'no se pudo conectar: ' + (e.message || e);
  }

  try {
    var bajadas = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
    informe.descargas = bajadas.map(function (d) {
      return {
        archivo: String(d.filename || '').split(/[\\/]/).pop() || '(sin nombre)',
        estado: d.state,
        error: d.error || '',
        bytes: d.fileSize || d.totalBytes || 0,
      };
    });
  } catch (e) {
    informe.descargas = 'error: ' + (e.message || e);
  }

  return informe;
}

/** Si Chrome interrumpe una descarga, queda anotado (y se ve en el popup). */
try {
  chrome.downloads.onChanged.addListener(function (delta) {
    if (delta.state && delta.state.current === 'interrupted') {
      var motivo = delta.error && delta.error.current ? delta.error.current : 'desconocido';
      anotarError('descarga interrumpida por Chrome', motivo, 'id ' + delta.id);
    }
  });
} catch (e) {
  /* sin permiso de descargas no hay nada que escuchar */
}

function avisarProgreso(mensaje) {
  chrome.runtime.sendMessage(mensaje).catch(function () {
    /* el popup puede estar cerrado: no importa */
  });
}

/** Descarga una lista de CDC, de a uno y con pausa. Avisa el avance. */
async function descargarVarios(cdcs) {
  var resultados = { descargado: 0, 'no-encontrado': 0, error: 0 };

  for (var i = 0; i < cdcs.length; i++) {
    var cdcLimpio = cdcs[i];
    avisarProgreso({ tipo: 'progreso', actual: i + 1, total: cdcs.length, cdc: cdcLimpio });

    try {
      var r = await descargarXml(cdcLimpio);
      if (r.ok) resultados.descargado++;
      else if (r.sesion) resultados.error++;
      else resultados['no-encontrado']++;
    } catch (err) {
      resultados.error++;
      await bandejaMarcar(cdcLimpio, 'error');
    }

    if (i < cdcs.length - 1) {
      await new Promise(function (res) {
        setTimeout(res, PAUSA_DESCARGA_MS);
      });
    }
  }

  avisarProgreso({ tipo: 'progreso', fin: true, total: cdcs.length, resultados: resultados });
  return resultados;
}

/* --------------------------------- flujo ---------------------------------- */

/** Punto de entrada común: normaliza y valida antes de cualquier cosa. */
function prepararCdc(texto) {
  var cdcLimpio = extraerCdc(texto);
  if (!cdcLimpio) return { error: 'No se encontró un CDC de 44 dígitos en la selección' };
  if (!validarCdc(cdcLimpio)) {
    return { error: 'CDC inválido: ' + formatearCdc(cdcLimpio) + ' (dígito verificador)' };
  }
  return { cdc: cdcLimpio, analisis: analizarCdc(cdcLimpio) };
}

/** Guarda el CDC en la bandeja con sus datos ya decodificados. */
async function registrar(cdcLimpio) {
  var a = analizarCdc(cdcLimpio);
  return bandejaAgregar(cdcLimpio, {
    tipoDocumento: a.tipoDocumentoNombre,
    rucEmisor: a.rucEmisor + '-' + a.dvRucEmisor,
    numero: a.establecimiento + '-' + a.puntoExpedicion + '-' + a.numeroDocumento,
    fechaEmision: a.fechaEmision,
  });
}

/** Flujo completo desde un texto que contiene (o debería contener) un CDC. */
async function descargarDesdeTexto(texto) {
  var prep = prepararCdc(texto);
  if (prep.error) {
    marcar(null, '!', '#b91c1c', prep.error);
    return { ok: false, motivo: prep.error };
  }

  await registrar(prep.cdc);

  try {
    var r = await descargarXml(prep.cdc);
    if (r.ok) {
      marcar(null, '✓', '#15803d', 'XML descargado: ' + formatearCdc(prep.cdc));
    } else if (r.sesion) {
      marcar(null, '!', '#b91c1c', r.motivo);
    } else {
      marcar(null, '·', '#a16207', formatearCdc(prep.cdc) + ': ' + r.motivo);
    }
    return r;
  } catch (err) {
    await bandejaMarcar(prep.cdc, 'error');
    marcar(null, '!', '#b91c1c', 'Error al descargar: ' + err.message);
    return { ok: false, cdc: prep.cdc, motivo: err.message };
  }
}

/** Lee el texto seleccionado en la pestaña activa (para los atajos). */
async function textoSeleccionado() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return '';

  try {
    var ejecucion = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: function () {
        return window.getSelection().toString();
      },
    });
    return ejecucion && ejecucion[0] ? ejecucion[0].result : '';
  } catch (err) {
    // Pestaña especial (chrome://, Web Store, visor de PDF): no se puede
    // inyectar. En ese caso conviene usar el menú contextual, que trae la
    // selección sin necesidad de inyectar nada.
    marcar(null, '!', '#b91c1c', 'No se pudo leer la selección en esta pestaña');
    return '';
  }
}

/* ------------------------------- mensajería -------------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, responder) {
  if (!msg) return false;

  if (msg.tipo === 'agregar') {
    var prep = prepararCdc(msg.cdc);
    if (prep.error) {
      responder({ ok: false, motivo: prep.error });
      return true;
    }
    registrar(prep.cdc).then(function () {
      responder({ ok: true });
    });
    return true;
  }

  if (msg.tipo === 'descargar') {
    descargarXml(msg.cdc).then(function (r) {
      responder(r);
    });
    return true;
  }

  if (msg.tipo === 'diagnostico') {
    diagnostico().then(function (informe) {
      responder(informe);
    });
    return true;
  }

  if (msg.tipo === 'descargar-todos') {
    chrome.storage.local.get('bandeja', function (datos) {
      var bandeja = Array.isArray(datos.bandeja) ? datos.bandeja : [];
      var objetivo = msg.soloPendientes
        ? bandeja.filter(function (e) {
            return e.xml !== 'descargado';
          })
        : bandeja;
      descargarVarios(
        objetivo.map(function (e) {
          return e.cdc;
        })
      ).then(function (resultados) {
        responder({ ok: true, resultados: resultados });
      });
    });
    return true;
  }

  return false;
});

/* ------------------------------- entradas ---------------------------------- */

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'descargarXml',
    title: 'Descargar XML del CDC (e-Kuatia)',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId === 'descargarXml') descargarDesdeTexto(info.selectionText);
});

chrome.commands.onCommand.addListener(async function (command) {
  if (command !== 'descargar_xml' && command !== 'descargar_xml_alt') return;
  var texto = await textoSeleccionado();
  if (texto) await descargarDesdeTexto(texto);
});
