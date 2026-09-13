/* Content script de la página de consultas de e-Kuatia.
 *
 * Se inyecta (vía manifest) en https://ekuatia.set.gov.py/consultas* y se
 * comunica con el service worker por mensajes. Hace cuatro cosas:
 *
 *   1. localiza el campo "Ingrese CDC" y lo rellena (Angular lo registra
 *      porque se usa el setter nativo de `value`, no una asignación directa);
 *   2. espera a que el reCAPTCHA tenga token —si es que la página lo tiene—
 *      así el solver externo (CaptchaRaptor) puede resolverlo;
 *   3. pulsa "Consultar";
 *   4. detecta los controles de descarga que aparecen con el resultado y los
 *      muestra en un panel, para saber qué ofrece la página (XML, KuDE, ambos).
 *
 * No hace suposiciones rígidas sobre el DOM: prueba varios selectores y
 * degrada de forma explícita. Si el sitio cambia, lo que falla es el
 * selector, no todo el flujo.
 */
(function () {
  'use strict';

  var SEL_TOKEN =
    'textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response, #g-recaptcha-response';

  var RE_DESCARGA = /descarg|download|xml|kude|pdf|imprimir|export|ver\b/i;

  /* ------------------------------ utilidades ------------------------------ */

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.offsetParent !== null;
  }

  function textoDe(el) {
    return ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.title || '')).trim();
  }

  function espera(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function conLimite(promesa, ms, etiqueta) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Tiempo de espera agotado: ' + etiqueta));
      }, ms);
      promesa.then(
        function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /* --------------------------- campo del CDC ------------------------------ */

  function metaDe(el) {
    return [
      el.id,
      el.name,
      el.placeholder,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('formcontrolname'),
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
  }

  function etiquetaDe(el) {
    var out = '';
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) out = l.textContent || '';
      }
      if (!out && el.closest('label')) out = el.closest('label').textContent || '';
      if (!out && el.parentElement) out = el.parentElement.textContent || '';
    } catch (e) {
      /* CSS.escape no existe en contextos raros: seguimos con lo que haya */
    }
    return out.trim();
  }

  /** Busca el input del CDC por capas, de lo más específico a lo más laxo. */
  function buscarInputCdc() {
    var todos = Array.prototype.slice
      .call(document.querySelectorAll('input, textarea'))
      .filter(function (el) {
        var t = (el.type || '').toLowerCase();
        return ['file', 'hidden', 'checkbox', 'radio', 'button', 'submit'].indexOf(t) === -1;
      })
      .filter(function (el) {
        return !el.disabled && !el.readOnly && visible(el);
      });

    if (!todos.length) return null;

    // 1) atributos que mencionen el CDC
    var porAtributo = todos.filter(function (el) {
      return metaDe(el).indexOf('CDC') !== -1;
    });
    if (porAtributo.length === 1) return porAtributo[0];

    // 2) etiqueta corta que mencione el CDC
    var porEtiqueta = todos.filter(function (el) {
      var txt = etiquetaDe(el);
      return txt.length > 0 && txt.length < 80 && /CDC/i.test(txt);
    });
    if (porEtiqueta.length === 1) return porEtiqueta[0];

    // 3) dentro del bloque "Consultar por CDC"
    var bloques = Array.prototype.slice.call(
      document.querySelectorAll('div, section, form, mat-card, fieldset, app-consulta')
    );
    var bloque = bloques.filter(function (n) {
      var txt = (n.textContent || '').toUpperCase();
      return (
        txt.indexOf('CONSULTAR POR CDC') !== -1 ||
        txt.indexOf('INGRESE CDC') !== -1
      );
    })[0];
    if (bloque) {
      var dentro = bloque.querySelector('input:not([type="file"]), textarea');
      if (dentro) return dentro;
    }

    // 4) último recurso: el primer campo de texto visible de la página
    return todos[0];
  }

  /** Escribe el valor usando el setter nativo: así se entera Angular. */
  function escribirCdc(input, cdc) {
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    if (setter) setter.call(input, cdc);
    else input.value = cdc;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));

    try {
      input.focus();
    } catch (e) {
      /* no pasa nada si no se puede enfocar */
    }
    return input.value === cdc;
  }

  /* ------------------------------ reCAPTCHA ------------------------------- */

  function tieneRecaptcha() {
    return !!document.querySelector(
      '.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="/recaptcha/"]'
    );
  }

  function leerToken() {
    var el = document.querySelector(SEL_TOKEN);
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  /**
   * Espera a que el reCAPTCHA tenga token.
   * Si la página no tiene reCAPTCHA, resuelve enseguida: en la consulta
   * pública el captcha aparece de forma condicional según la IP y el volumen
   * de consultas, así que no se puede asumir ni que está ni que no está.
   */
  function esperarToken(ms) {
    if (!tieneRecaptcha()) {
      return { espero: false, token: '' };
    }
    if (leerToken()) {
      return { espero: false, token: leerToken() };
    }
    var limite = Date.now() + ms;
    var paso = 300;
    return (function intentar() {
      var token = leerToken();
      if (token) return { espero: true, token: token };
      if (Date.now() > limite) return { espero: true, token: '' };
      return espera(paso).then(intentar);
    })();
  }

  /* --------------------------- botón Consultar ---------------------------- */

  function buscarBotonConsultar() {
    var candidatos = Array.prototype.slice
      .call(
        document.querySelectorAll(
          'button, a[href], [role="button"], input[type="button"], input[type="submit"]'
        )
      )
      .filter(visible);

    // El bloque "Visualizar por XML" también tiene un botón, pero no consulta.
    var bloqueXml = (function () {
      var nodos = Array.prototype.slice.call(document.querySelectorAll('div, section, form'));
      return nodos.filter(function (n) {
        return /subir xml|visualizar por xml/i.test(n.textContent || '');
      })[0];
    })();

    var porTexto = candidatos.filter(function (el) {
      if (bloqueXml && bloqueXml.contains(el)) return false;
      var txt = (el.textContent || el.value || '').trim();
      return /^consultar$/i.test(txt) || /consultar/i.test(metaDe(el));
    });
    if (porTexto.length) return porTexto[0];

    var conFormulario = candidatos.filter(function (el) {
      var form = el.closest ? el.closest('form') : null;
      return !!form;
    });
    return conFormulario[0] || null;
  }

  function clickEn(el) {
    if (!el) return false;
    if (typeof el.click === 'function') el.click();
    else
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      );
    return true;
  }

  /* --------------------- detección de descargas --------------------------- */

  /** Lista los controles que la página ofrece como descarga/visualización. */
  function detectarControles() {
    return Array.prototype.slice
      .call(document.querySelectorAll('button, a[href], [role="button"], input[type="button"]'))
      .filter(visible)
      .filter(function (el) {
        return RE_DESCARGA.test(textoDe(el)) || RE_DESCARGA.test(metaDe(el));
      })
      .map(function (el) {
        return {
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          texto: (el.textContent || el.value || '').trim().slice(0, 80),
          id: el.id || null,
          clases: (el.className || '').toString().slice(0, 120),
          href: el.getAttribute ? el.getAttribute('href') : null,
          title: el.getAttribute ? el.getAttribute('title') : null,
        };
      });
  }

  /** Espera a que el panel de resultado se poble (o a que aparezca un error). */
  function esperarResultado(ms) {
    var limite = Date.now() + ms;
    var RE_LISTO = /aprobado|rechazado|cancelado|inutilizado|no encontrado|no existe|inválid|invalid/i;
    return (function intentar() {
      var txt = document.body ? document.body.innerText || '' : '';
      if (RE_LISTO.test(txt)) {
        var m = txt.match(RE_LISTO);
        return { estado: m ? m[0] : 'desconocido' };
      }
      if (Date.now() > limite) return { estado: 'sin-resultado' };
      return espera(400).then(intentar);
    })();
  }

  /* ------------------------- panel de diagnóstico ------------------------- */

  function mostrarPanel(cdc, estado, controles) {
    document.getElementById('ekuatia-panel')?.remove();

    var panel = document.createElement('div');
    panel.id = 'ekuatia-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:420px',
      'background:#111827',
      'color:#f9fafb',
      'border-radius:10px',
      'padding:14px 16px',
      'font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.45)',
    ].join(';');

    var titulo = document.createElement('div');
    titulo.style.cssText = 'font-weight:600;margin-bottom:8px';
    titulo.textContent = 'e-Kuatia — resultado';
    panel.appendChild(titulo);

    var cuerpo = document.createElement('div');
    cuerpo.style.cssText = 'margin-bottom:10px';
    cuerpo.innerHTML =
      '<div>CDC: <code style="color:#93c5fd">' +
      formatearCdc(cdc) +
      '</code></div>' +
      '<div>Estado detectado: <b>' +
      estado +
      '</b></div>';
    panel.appendChild(cuerpo);

    var lista = document.createElement('div');
    lista.style.cssText = 'margin-bottom:10px;max-height:220px;overflow:auto';
    if (!controles.length) {
      lista.textContent = 'No se detectaron controles de descarga.';
      lista.style.opacity = '0.75';
    } else {
      var ul = document.createElement('ul');
      ul.style.cssText = 'margin:0;padding-left:18px';
      controles.forEach(function (c) {
        var li = document.createElement('li');
        li.textContent =
          '<' + c.tag + (c.type ? ' type=' + c.type : '') + '> ' + (c.texto || '(sin texto)');
        if (c.href) li.textContent += ' → ' + c.href;
        ul.appendChild(li);
      });
      lista.appendChild(ul);
    }
    panel.appendChild(lista);

    var acciones = document.createElement('div');
    acciones.style.cssText = 'display:flex;gap:8px';

    var btnCopiar = document.createElement('button');
    btnCopiar.textContent = 'Copiar informe';
    btnCopiar.style.cssText =
      'background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit';
    btnCopiar.addEventListener('click', function () {
      var informe = JSON.stringify(
        { cdc: cdc, estado: estado, controles: controles, url: location.href },
        null,
        2
      );
      navigator.clipboard.writeText(informe).then(
        function () {
          btnCopiar.textContent = '¡Copiado!';
          setTimeout(function () {
            btnCopiar.textContent = 'Copiar informe';
          }, 1500);
        },
        function () {
          btnCopiar.textContent = 'No se pudo copiar';
        }
      );
    });

    var btnCerrar = document.createElement('button');
    btnCerrar.textContent = 'Cerrar';
    btnCerrar.style.cssText =
      'background:#374151;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit';
    btnCerrar.addEventListener('click', function () {
      panel.remove();
    });

    acciones.appendChild(btnCopiar);
    acciones.appendChild(btnCerrar);
    panel.appendChild(acciones);

    document.body.appendChild(panel);
  }

  /* ------------------------------- flujo ---------------------------------- */

  /**
   * Rellena el CDC, espera el token del reCAPTCHA y consulta.
   * Devuelve un informe; nunca lanza.
   */
  function consultar(cdc, opciones) {
    var opts = opciones || {};
    var tokenMs = opts.tokenMs || 90000;
    var resultadoMs = opts.resultadoMs || 30000;

    var input = buscarInputCdc();
    if (!input) {
      return Promise.resolve({ ok: false, etapa: 'input', detalle: 'No se encontró el campo CDC' });
    }

    var limpio = normalizarCdc(cdc);
    escribirCdc(input, limpio);

    return Promise.resolve(esperarToken(tokenMs))
      .then(function (t) {
        var boton = buscarBotonConsultar();
        if (!boton) {
          return {
            ok: false,
            etapa: 'boton',
            detalle: 'No se encontró el botón Consultar',
            captcha: t.espero,
            token: !!t.token,
          };
        }
        clickEn(boton);

        return conLimite(
          Promise.resolve(esperarResultado(resultadoMs)),
          resultadoMs + 5000,
          'resultado'
        ).then(function (res) {
          var controles = detectarControles();
          return {
            ok: res.estado !== 'sin-resultado',
            etapa: 'resultado',
            detalle: res.estado,
            captcha: t.espero,
            token: !!t.token,
            controles: controles,
          };
        });
      })
      .catch(function (err) {
        return { ok: false, etapa: 'error', detalle: String(err && err.message ? err.message : err) };
      });
  }

  /* ---------------------------- mensajería -------------------------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, responder) {
    if (!msg || msg.tipo !== 'consultar') return false;

    consultar(msg.cdc, { tokenMs: msg.tokenMs, resultadoMs: msg.resultadoMs }).then(function (res) {
      // Se informa por mensaje aparte para no mantener colgado al service worker.
      chrome.runtime.sendMessage({ tipo: 'resultado', cdc: normalizarCdc(msg.cdc), res: res }).catch(
        function () {}
      );
      if (msg.mostrarPanel !== false) {
        mostrarPanel(msg.cdc, res.detalle || res.etapa, res.controles || []);
      }
      responder({ recibido: true });
    });

    return true; // respuesta asíncrona
  });
})();
