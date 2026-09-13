/* Service worker — extensión "Buscar CDC en e-Kuatia".
 *
 * Flujo completo:
 *   1. llega un CDC (menú contextual sobre la selección, o atajo Alt+C);
 *   2. se valida: 44 dígitos y dígito verificador módulo 11. Si no cierra,
 *      se avisa y no se toca la página. Si del texto seleccionado se puede
 *      rescatar un CDC de 44 dígitos (por ejemplo con espacios o rodeado de
 *      otro texto), se usa ese;
 *   3. se reutiliza la pestaña de e-Kuatia si ya está abierta, o se abre
 *      /consultas/ y se espera a que cargue (con tiempo límite);
 *   4. el content script rellena el campo, espera el token del reCAPTCHA
 *      (que resuelve el solver externo) y pulsa "Consultar";
 *   5. el content script vuelve a avisar con el estado y los controles de
 *      descarga que ofrece la página; acá sólo se refleja en el badge y se
 *      guarda el CDC en la bandeja.
 */

importScripts('src/cdc.js');

var URL_CONSULTA = 'https://ekuatia.set.gov.py/consultas/';
var ESPERA_CARGA_MS = 30000;
var ESPERA_TOKEN_MS = 90000;
var MAX_BANDEJA = 500;

/* ------------------------------- bandeja ---------------------------------- */

async function bandejaLeer() {
  var datos = await chrome.storage.local.get('bandeja');
  return Array.isArray(datos.bandeja) ? datos.bandeja : [];
}

async function bandejaAgregar(cdc, extra) {
  var bandeja = await bandejaLeer();
  var entrada = { cdc: cdc, ts: Date.now() };
  if (extra) Object.assign(entrada, extra);

  // Si ya estaba, se actualiza en el mismo lugar en vez de duplicar.
  var idx = bandeja.findIndex(function (e) {
    return e.cdc === cdc;
  });
  if (idx !== -1) bandeja[idx] = entrada;
  else bandeja.push(entrada);

  if (bandeja.length > MAX_BANDEJA) bandeja = bandeja.slice(-MAX_BANDEJA);
  await chrome.storage.local.set({ bandeja: bandeja });
  return bandeja;
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

/* ------------------------------- pestañas --------------------------------- */

/** Espera a que la pestaña termine de cargar, con tiempo límite. */
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

/** Devuelve la pestaña de e-Kuatia: la reutiliza si existe, si no la crea. */
async function obtenerTabDeConsulta() {
  var pestañas = await chrome.tabs.query({ url: '*://ekuatia.set.gov.py/*' });
  if (pestañas.length) return pestañas[0];

  var tab = await chrome.tabs.create({ url: URL_CONSULTA });
  await esperarCargaCompleta(tab.id);
  return tab;
}

/** ¿Ya cargó la pestaña? Si no, espera. */
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

/* -------------------------------- flujo ----------------------------------- */

/** Manda el CDC al content script; si no está inyectado, lo inyecta antes. */
async function enviarAContent(tabId, mensaje) {
  try {
    await chrome.tabs.sendMessage(tabId, mensaje);
    return true;
  } catch (e) {
    // La página se cargó antes de que el content script estuviera listo, o
    // se navegó a otra ruta de la SPA: se inyecta a mano y se reintenta.
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

async function buscarCDC(texto) {
  var cdc = extraerCdc(texto);

  if (!cdc) {
    marcar(null, '!', '#b91c1c', 'No se encontró un CDC de 44 dígitos en la selección');
    return { ok: false, motivo: 'sin-cdc' };
  }
  if (!validarCdc(cdc)) {
    marcar(null, '!', '#b91c1c', 'CDC inválido: ' + formatearCdc(cdc) + ' (dígito verificador)');
    return { ok: false, motivo: 'cdc-invalido', cdc: cdc };
  }

  var analisis = analizarCdc(cdc);
  var tab = await obtenerTabDeConsulta();
  tab = await asegurarCarga(tab);

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  marcar(tab.id, '…', '#6b7280', 'Esperando el reCAPTCHA y consultando ' + formatearCdc(cdc));

  var entregado = await enviarAContent(tab.id, {
    tipo: 'consultar',
    cdc: cdc,
    tokenMs: ESPERA_TOKEN_MS,
  });

  if (!entregado) {
    marcar(tab.id, '!', '#b91c1c', 'No se pudo inyectar el script en la página');
    return { ok: false, motivo: 'sin-content', cdc: cdc };
  }

  await bandejaAgregar(cdc, {
    tipoDocumento: analisis.tipoDocumentoNombre,
    rucEmisor: analisis.rucEmisor + '-' + analisis.dvRucEmisor,
    numero: analisis.establecimiento + '-' + analisis.puntoExpedicion + '-' + analisis.numeroDocumento,
    fechaEmision: analisis.fechaEmision,
  });

  return { ok: true, cdc: cdc, tabId: tab.id };
}

/* --------------------------- resultado del flujo --------------------------- */

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.tipo !== 'resultado') return false;
  var res = msg.res || {};

  // El mensaje llega desde la pestaña; el badge se pone en la pestaña activa.
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tabId = tabs && tabs.length ? tabs[0].id : null;
    if (res.ok) {
      marcar(tabId, '✓', '#15803d', 'Consulta realizada — estado: ' + res.detalle);
    } else {
      marcar(tabId, '!', '#b91c1c', 'Fallo en «' + res.etapa + '»: ' + res.detalle);
    }
  });

  if (res.controles && res.controles.length) {
    // Queda registrado en el log del service worker: sirve para documentar
    // qué ofrece la página (XML, KuDE, etc.) sin depender de capturas.
    console.info('[e-Kuatia] controles de descarga detectados:', res.controles);
  }
  return false;
});

/* ------------------------------ entrada de datos --------------------------- */

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'buscarCDC',
    title: 'Buscar CDC en e-Kuatia',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId === 'buscarCDC') buscarCDC(info.selectionText);
});

chrome.commands.onCommand.addListener(async function (command) {
  if (command !== 'buscar_cdc') return;
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return;

  var ejecucion = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: function () {
      return window.getSelection().toString();
    },
  });

  var texto = ejecucion && ejecucion[0] ? ejecucion[0].result : '';
  await buscarCDC(texto);
});
