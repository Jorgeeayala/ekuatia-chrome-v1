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
 * El endpoint es público: no hace falta certificado, sesión ni captcha.
 * Cuando el CDC no tiene XML público (inexistente, rechazado o inutilizado)
 * responde 200 con un HTML vacío, así que la respuesta se valida antes de
 * grabar. Ver DESCARGA-XML.md.
 */

importScripts('src/cdc.js');

var URL_XML = 'https://ekuatia.set.gov.py/docs/documento-electronico-xml/';
var CARPETA_XML = 'e-Kuatia/xml';
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

/* --------------------------- descarga del XML ------------------------------ */

/**
 * Pide el XML y comprueba que realmente lo sea: el servidor responde 200 con
 * un HTML vacío cuando el CDC no tiene XML público.
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
    avisarProgreso({ tipo: 'progreso', actual: i + 1, total: cdcs.length, cdc: cdcLimpio });

    try {
      var r = await descargarXml(cdcLimpio);
      if (r.ok) resultados.descargado++;
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
