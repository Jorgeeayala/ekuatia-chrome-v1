// Función para esperar que la pestaña termine de cargar
async function esperarCargaCompleta(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Función principal para buscar CDC
async function buscarCDC(texto) {
  if (!texto) return;

  let [targetTab] = await chrome.tabs.query({
    url: "*://ekuatia.set.gov.py/*"
  });

  if (!targetTab) {
    targetTab = await chrome.tabs.create({
      url: "https://ekuatia.set.gov.py/consultas/"
    });
    await esperarCargaCompleta(targetTab.id);
  }

  await chrome.tabs.update(targetTab.id, { active: true });
  await chrome.windows.update(targetTab.windowId, { focused: true });

  chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (cdc) => {
      function intentar() {
        const input = document.querySelector("input"); // Cambiar selector si es necesario
        if (input) {
          input.value = cdc.replace(/\s+/g, '');
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        } else {
          setTimeout(intentar, 100);
        }
      }
      intentar();
    },
    args: [texto]
  });
}

// Crear menú contextual
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "buscarCDC",
    title: "Buscar CDC en e-Kuatia",
    contexts: ["selection"]
  });
});

// Click derecho
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "buscarCDC") {
    buscarCDC(info.selectionText);
  }
});

// Hotkey Alt+C
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "buscar_cdc") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    }, (selection) => {
      const texto = selection[0].result;
      buscarCDC(texto);
    });
  }
});