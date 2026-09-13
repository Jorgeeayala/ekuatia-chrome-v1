/* Service worker — extensión "Buscar CDC en e-Kuatia".
 *
 * Hay dos caminos, y conviene entender cuándo usar cada uno:
 *
 *   1) CONSULTA WEB (con reCAPTCHA)
 *      Rellena el campo en /consultas/, espera el token y pulsa "Consultar".
 *      Es la vía para ver el estado y el KuDE en la pantalla de la SET.
 *
 *   2) DESCARGA DIRECTA DEL XML (sin captcha)  ← el importante
 *      GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>
 *      devuelve el XML firmado del DTE. Es público: no hace falta certificado,
 *      sesión ni navegador. Si el CDC no tiene XML público responde 200 con un
 *      HTML vacío, así que la respuesta se valida antes de grabar. Ver
 *      DESCARGA-XML.md.
 *
 * Entradas: menú contextual sobre la selección, atajos Alt+C / Alt+X, y el
 * popup (que también descarga la bandeja completa).
 */

importScripts('src/cdc.js');

var URL_CONSULTA = 'https://ekuatia.set.gov.py/consultas/';
var URL_XML = 'https://ekuatia.set.gov.py/docs/documento-electronico-xml/';
var CARPETA_XML = 'e-Kuatia/xml';

var ESPERA_CARGA_MS = 30000;
var ESPERA_TOKEN_MS = 90000;
var PAUSA_DESCARGA_MS = 1200;
var MAX_BANDEJA = 500;

var RE_XML = /^\s*(<\?xml|<rde|<rDE)/i;

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

async function bandejaMarcar(cdcLimpio, estadoXml) {
  var bandeja = await bandejaLeer();
  for (var i = 0; i < bandeja.length; i++) {
    if (bandeja[i].cdc === cdcLimpio) {
      bandeja[i].xml = estadoXml;
      bandeja[i].xmlTs = Date.now();
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

/* --------------------- descarga directa del XML --------------------------- */

/**
 * Pide el XML y comprueba que realmente lo sea.
 * El servidor responde 200 + HTML vacío cuando el CDC no tiene XML público
 * (inexistente, rechazado, inutilizado o aún no disponible).
 */
async function verificarXml(cdcLimpio) {
  var resp = await fetch(URL_XML + cdcLimpio, {
    method: 'GET',
    headers: { Accept: 'application/xml' },
    redirect: 'follow',
  });

  if (!resp.ok) return { ok: false, motivo: 'HTTP ' + resp.status };

  var texto = await resp.text();
  if (!RE_XML.test(texto)) {
    return { ok: false, motivo: 'sin XML público (inexistente, rechazado o inutilizado)' };
  }
  return { ok: true, bytes: texto.length };
}

/** Descarga el XML de un CDC a la carpeta e-Kuatia/xml/. */
async function descargarXml(cdcLimpio) {
  var ver = await verificarXml(cdcLimpio);

  if (!ver.ok) {
    await bandejaMarcar(cdcLimpio, 'no-encontrado');
    return { ok: false, cdc: cdcLimpio, motivo: ver.motivo };
  }

  var id = await chrome.downloads.download({
    url: URL_XML + cdcLimpio,
    filename: CARPETA_XML + '/' + cdcLimpio + '.xml',
    conflictAction: 'overwrite',
    saveAs: false,
  });

  await bandejaAgregar(cdcLimpio, {});
  await bandejaMarcar(cdcLimpio, 'descargado');
  return { ok: true, cdc: cdcLimpio, downloadId: id, bytes: ver.bytes };
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
    avisarProgreso({
      tipo: 'progreso',
      actual: i + 1,
      total: cdcs.length,
      cdc: cdcLimpio,
    });

    try {
      await descargarXml(cdcLimpio);
      resultados.descargado++;
    } catch (err) {
      resultados.error++;
      await bandejaMarcar(cdcLimpio, 'error');
    }

    if (i < cdcs.length - 1) {
      await new Promise(function (r) {
        setTimeout(r, PAUSA_DESCARGA_MS);
      });
    }
  }

  avisarProgreso({ tipo: 'progreso', fin: true, total: cdcs.length, resultados: resultados });
  return resultados;
}

/* ------------------------------- pestañas --------------------------------- */

function esperarCargaCompleta(tabId, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('La pestaña no terminó de cargar'));
    }, ms || ESPERA_CARGA_MS);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function obtenerTabDeConsulta() {
  var pestañas = await chrome.tabs.query({ url: '*://ekuatia.set.gov.py/*' });
  if (pestañas.length) return pestañas[0];

  var tab = await chrome.tabs.create({ url: URL_CONSULTA });
  await esperarCargaCompleta(tab.id);
  return tab;
}

async function asegurarCarga(tab) {
  try {
    var actual = await chrome.tabs.get(tab.id);
    if (actual.status === 'complete') return tab;
  } catch (e) {
    /* la pestaña desapareció: se vuelve a crear abajo */
  }
  await esperarCargaCompleta(tab.id);
  return tab;
}

/* ------------------------- consulta web (con captcha) ---------------------- */

async function enviarAContent(tabId, mensaje) {
  try {
    await chrome.tabs.sendMessage(tabId, mensaje);
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['src/cdc.js', 'src/content.js'],
      });
      await chrome.tabs.sendMessage(tabId, mensaje);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/* -------------------------------- flujos ---------------------------------- */

/** Punto de entrada común: normaliza y valida antes de cualquier cosa. */
function prepararCdc(texto) {
  var cdcLimpio = extraerCdc(texto);
  if (!cdcLimpio) return { error: 'No se encontró un CDC de 44 dígitos en la selección' };
  if (!validarCdc(cdcLimpio)) {
    return { error: 'CDC inválido: ' + formatearCdc(cdcLimpio) + ' (dígito verificador)' };
  }
  return { cdc: cdcLimpio, analisis: analizarCdc(cdcLimpio) };
}

/** Flujo 1: rellenar la web, esperar el captcha y consultar. */
async function consultarEnWeb(texto) {
  var prep = prepararCdc(texto);
  if (prep.error) {
    marcar(null, '!', '#b91c1c', prep.error);
    return { ok: false, motivo: prep.error };
  }

  var a = prep.analisis;
  var tab = await obtenerTabDeConsulta();
  tab = await asegurarCarga(tab);

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  marcar(tab.id, '…', '#6b7280', 'Esperando el reCAPTCHA: ' + formatearCdc(prep.cdc));

  var entregado = await enviarAContent(tab.id, {
    tipo: 'consultar',
    cdc: prep.cdc,
    tokenMs: ESPERA_TOKEN_MS,
  });

  if (!entregado) {
    marcar(tab.id, '!', '#b91c1c', 'No se pudo inyectar el script en la página');
    return { ok: false, motivo: 'sin-content', cdc: prep.cdc };
  }

  await bandejaAgregar(prep.cdc, {
    tipoDocumento: a.tipoDocumentoNombre,
    rucEmisor: a.rucEmisor + '-' + a.dvRucEmisor,
    numero: a.establecimiento + '-' + a.puntoExpedicion + '-' + a.numeroDocumento,
    fechaEmision: a.fechaEmision,
  });

  return { ok: true, cdc: prep.cdc, tabId: tab.id };
}

/** Flujo 2: descargar el XML sin pasar por la web. */
async function descargarDesdeTexto(texto) {
  var prep = prepararCdc(texto);
  if (prep.error) {
    marcar(null, '!', '#b91c1c', prep.error);
    return { ok: false, motivo: prep.error };
  }

  var a = prep.analisis;
  await bandejaAgregar(prep.cdc, {
    tipoDocumento: a.tipoDocumentoNombre,
    rucEmisor: a.rucEmisor + '-' + a.dvRucEmisor,
    numero: a.establecimiento + '-' + a.puntoExpedicion + '-' + a.numeroDocumento,
    fechaEmision: a.fechaEmision,
  });

  try {
    var r = await descargarXml(prep.cdc);
    if (r.ok) {
      marcar(null, '✓', '#15803d', 'XML descargado: ' + formatearCdc(prep.cdc));
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

/* ---------------------------- mensajería externa --------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, responder) {
  // Resultado de la consulta web (llega del content script de la página).
  if (msg && msg.tipo === 'resultado') {
    var res = msg.res || {};
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tabId = tabs && tabs.length ? tabs[0].id : null;
      if (res.ok) marcar(tabId, '✓', '#15803d', 'Consulta realizada — estado: ' + res.detalle);
      else marcar(tabId, '!', '#b91c1c', 'Fallo en «' + res.etapa + '»: ' + res.detalle);
    });
    if (res.controles && res.controles.length) {
      console.info('[e-Kuatia] controles de descarga detectados:', res.controles);
    }
    return false;
  }

  // Pedidos del popup.
  if (msg && msg.tipo === 'agregar') {
    var prepAgregar = prepararCdc(msg.cdc);
    if (prepAgregar.error) {
      responder({ ok: false, motivo: prepAgregar.error });
      return true;
    }
    var a2 = prepAgregar.analisis;
    bandejaAgregar(prepAgregar.cdc, {
      tipoDocumento: a2.tipoDocumentoNombre,
      rucEmisor: a2.rucEmisor + '-' + a2.dvRucEmisor,
      numero: a2.establecimiento + '-' + a2.puntoExpedicion + '-' + a2.numeroDocumento,
      fechaEmision: a2.fechaEmision,
    }).then(function () {
      responder({ ok: true });
    });
    return true;
  }

  if (msg && msg.tipo === 'descargar') {
    descargarXml(msg.cdc).then(function (r) {
      responder(r);
    });
    return true;
  }

  if (msg && msg.tipo === 'descargar-todos') {
    chrome.storage.local.get('bandeja', function (datos) {
      var bandeja = Array.isArray(datos.bandeja) ? datos.bandeja : [];
      var pendientes = msg.soloPendientes
        ? bandeja.filter(function (e) {
            return e.xml !== 'descargado';
          })
        : bandeja;
      descargarVarios(
        pendientes.map(function (e) {
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

/* ------------------------------ entradas ---------------------------------- */

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'descargarXml',
    title: 'Descargar XML del CDC (e-Kuatia)',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'buscarCDC',
    title: 'Consultar CDC en e-Kuatia (web)',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId === 'descargarXml') descargarDesdeTexto(info.selectionText);
  else if (info.menuItemId === 'buscarCDC') consultarEnWeb(info.selectionText);
});

chrome.commands.onCommand.addListener(async function (command) {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return;

  var ejecucion = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: function () {
      return window.getSelection().toString();
    },
  });
  var texto = ejecucion && ejecucion[0] ? ejecucion[0].result : '';

  if (command === 'descargar_xml') await descargarDesdeTexto(texto);
  else if (command === 'buscar_cdc') await consultarEnWeb(texto);
});
