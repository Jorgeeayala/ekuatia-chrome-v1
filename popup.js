/* Popup: bandeja de CDC + descarga de los XML.
 *
 * La bandeja es la entrada del descargador: cada CDC consultado queda acá con
 * su estado (descargado / sin XML público / error / pendiente).
 */

document.addEventListener('DOMContentLoaded', function () {
  var lista = document.getElementById('lista');
  var estado = document.getElementById('estado');
  var inputCdc = document.getElementById('cdc');
  var btnAgregar = document.getElementById('agregar');
  var btnTodos = document.getElementById('descargarTodos');
  var btnPendientes = document.getElementById('descargarPendientes');
  var btnCopiar = document.getElementById('copiar');
  var btnLimpiar = document.getElementById('limpiar');

  var ETIQUETA = {
    descargado: ['ok', 'descargado'],
    'no-encontrado': ['no', 'sin XML'],
    error: ['err', 'error'],
  };

  function chip(entry) {
    var span = document.createElement('span');
    var def = ETIQUETA[entry.xml];
    span.className = 'chip' + (def ? ' ' + def[0] : '');
    span.textContent = def ? def[1] : 'pendiente';
    if (!def) span.title = 'Todavía no se intentó descargar';
    else if (entry.xmlMotivo) span.title = entry.xmlMotivo;
    return span;
  }

  function pintar(bandeja) {
    lista.innerHTML = '';
    if (!bandeja.length) {
      var vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Sin CDC. Pegá uno arriba, o seleccioná un CDC en cualquier página y usá Alt+X.';
      lista.appendChild(vacio);
      return;
    }

    bandeja
      .slice()
      .reverse()
      .forEach(function (entrada) {
        var li = document.createElement('li');

        var datos = document.createElement('div');
        datos.className = 'datos';

        var cdc = document.createElement('code');
        cdc.textContent = formatearCdc(entrada.cdc);
        datos.appendChild(cdc);

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
        datos.appendChild(meta);
        li.appendChild(datos);

        li.appendChild(chip(entrada));

        var btn = document.createElement('button');
        btn.className = 'chico secundario';
        btn.textContent = 'XML';
        btn.title = 'Descargar el XML de este CDC';
        btn.addEventListener('click', function () {
          estado.textContent = 'Descargando ' + formatearCdc(entrada.cdc) + '…';
          chrome.runtime.sendMessage({ tipo: 'descargar', cdc: entrada.cdc }, function (r) {
            if (!r) return;
            estado.textContent = r.ok
              ? 'Descargado ' + formatearCdc(entrada.cdc) + ' (' + Math.round(r.bytes / 1024) + ' KB)'
              : 'Sin XML: ' + r.motivo;
            recargar();
          });
        });
        li.appendChild(btn);

        lista.appendChild(li);
      });
  }

  function recargar() {
    chrome.storage.local.get('bandeja', function (datos) {
      pintar(Array.isArray(datos.bandeja) ? datos.bandeja : []);
    });
  }

  /* ------------------------------- acciones -------------------------------- */

  btnAgregar.addEventListener('click', function () {
    var cdcLimpio = extraerCdc(inputCdc.value);
    if (!cdcLimpio || !validarCdc(cdcLimpio)) {
      estado.textContent = 'Ese CDC no es válido (44 dígitos y dígito verificador).';
      return;
    }
    chrome.runtime.sendMessage({ tipo: 'agregar', cdc: cdcLimpio }, function () {
      inputCdc.value = '';
      estado.textContent = 'Agregado ' + formatearCdc(cdcLimpio);
      recargar();
    });
  });

  btnTodos.addEventListener('click', function () {
    lote(false);
  });
  btnPendientes.addEventListener('click', function () {
    lote(true);
  });

  function lote(soloPendientes) {
    btnTodos.disabled = true;
    btnPendientes.disabled = true;
    estado.textContent = 'Descargando…';
    chrome.runtime.sendMessage({ tipo: 'descargar-todos', soloPendientes: soloPendientes }, function (r) {
      btnTodos.disabled = false;
      btnPendientes.disabled = false;
      if (r && r.resultados) {
        var x = r.resultados;
        estado.textContent =
          'Listo: ' + x.descargado + ' descargados, ' + x['no-encontrado'] + ' sin XML, ' + x.error + ' con error.';
      } else {
        estado.textContent = 'No se pudo completar (¿se cerró el popup? para lotes grandes usá el script).';
      }
      recargar();
    });
  }

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
          btnCopiar.textContent = 'Copiar';
        }, 1500);
      });
    });
  });

  btnLimpiar.addEventListener('click', function () {
    chrome.storage.local.set({ bandeja: [] }, function () {
      estado.textContent = '';
      pintar([]);
    });
  });

  /* ------------------------------ progreso --------------------------------- */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.tipo !== 'progreso') return false;
    if (msg.fin) {
      estado.textContent =
        'Fin: ' +
        msg.resultados.descargado +
        ' descargados, ' +
        msg.resultados['no-encontrado'] +
        ' sin XML, ' +
        msg.resultados.error +
        ' con error.';
      recargar();
    } else {
      estado.textContent = 'Descargando ' + msg.actual + '/' + msg.total + '…';
    }
    return false;
  });

  recargar();
});
