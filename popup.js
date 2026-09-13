/* Popup: bandeja de CDC consultados.
 * Se guardan para poder exportarlos y usarlos como entrada del descargador
 * de XML (pieza que vive fuera del navegador).
 */

document.addEventListener('DOMContentLoaded', function () {
  var lista = document.getElementById('lista');
  var btnCopiar = document.getElementById('copiar');
  var btnLimpiar = document.getElementById('limpiar');

  function pintar(bandeja) {
    lista.innerHTML = '';
    if (!bandeja.length) {
      var vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Todavía no se consultó ningún CDC.';
      lista.appendChild(vacio);
      return;
    }

    bandeja
      .slice()
      .reverse()
      .forEach(function (entrada) {
        var li = document.createElement('li');

        var cdc = document.createElement('code');
        cdc.textContent = formatearCdc(entrada.cdc);
        li.appendChild(cdc);

        var meta = document.createElement('div');
        meta.className = 'meta';
        var partes = [];
        if (entrada.tipoDocumento) partes.push(entrada.tipoDocumento);
        if (entrada.rucEmisor) partes.push('RUC ' + entrada.rucEmisor);
        if (entrada.numero) partes.push('Nº ' + entrada.numero);
        if (entrada.fechaEmision) {
          var f = fechaDeCdc(entrada.fechaEmision);
          if (f) partes.push(f.toLocaleDateString('es-PY'));
        }
        meta.textContent = partes.join(' · ');
        li.appendChild(meta);

        lista.appendChild(li);
      });
  }

  chrome.storage.local.get('bandeja', function (datos) {
    pintar(Array.isArray(datos.bandeja) ? datos.bandeja : []);
  });

  btnCopiar.addEventListener('click', function () {
    chrome.storage.local.get('bandeja', function (datos) {
      var bandeja = Array.isArray(datos.bandeja) ? datos.bandeja : [];
      var texto = bandeja
        .map(function (e) {
          return e.cdc;
        })
        .join('\n');
      navigator.clipboard.writeText(texto).then(function () {
        btnCopiar.textContent = '¡Copiado!';
        setTimeout(function () {
          btnCopiar.textContent = 'Copiar todos';
        }, 1500);
      });
    });
  });

  btnLimpiar.addEventListener('click', function () {
    chrome.storage.local.set({ bandeja: [] }, function () {
      pintar([]);
    });
  });
});
