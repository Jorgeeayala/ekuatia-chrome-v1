# Buscar CDC en e-Kuatia

Extensión de Chrome (Manifest V3) para consultar comprobantes electrónicos en
[e-Kuatia](https://ekuatia.set.gov.py/consultas/) (SIFEN, DNIT Paraguay) a
partir del **CDC** — el Código de Control de 44 dígitos que figura en el KuDE.

Seleccionás el CDC en cualquier lado, y la extensión abre (o reutiliza) la
pestaña de e-Kuatia, rellena el campo, espera a que el reCAPTCHA esté resuelto
y pulsa *Consultar* por vos.

## Instalación

1. `chrome://extensions` → activar **Modo de desarrollador**
2. **Cargar descomprimida** → seleccionar esta carpeta
3. (Opcional, recomendado) instalar
   [CaptchaRaptor](https://github.com/CaptchaRaptor/captchaplugin) cargando su
   carpeta `extension/`. Es una **extensión aparte**: resuelve el reCAPTCHA
   dentro del iframe de Google. Esta extensión no habla con ella, sólo espera a
   que el token aparezca en la página.

## Uso

- **Menú contextual**: seleccioná el CDC con el mouse → clic derecho →
  *Buscar CDC en e-Kuatia*
- **Atajo**: seleccioná el CDC y pulsá `Alt+C`
- **Popup** (ícono de la extensión): bandeja con los CDC consultados y un botón
  para copiarlos todos, uno por línea.

El CDC se acepta con espacios, puntos o guiones (el KuDE lo imprime en grupos
de cuatro) y se valida: 44 dígitos y **dígito verificador módulo 11** según el
Manual Técnico del SIFEN v150 §10.1 y §10.2. Si el dígito no cierra, la
extensión avisa con una `!` roja en el ícono y no toca la página.

## Cómo funciona

```
selección de texto
   └─► background.js: extrae un CDC de 44 dígitos y lo valida (módulo 11)
        └─► reutiliza la pestaña de e-Kuatia, o abre /consultas/ (con límite de espera)
             └─► content.js:
                  1. localiza el campo "Ingrese CDC" y lo rellena
                     (setter nativo de `value`, para que Angular lo registre)
                  2. si la página tiene reCAPTCHA, espera el token
                     (hasta 90 s — es lo que resuelve CaptchaRaptor)
                  3. pulsa "Consultar"
                  4. espera el resultado y enumera los controles de descarga
                  5. muestra un panel con el estado y avisa al service worker
```

Si el sitio cambia el DOM, lo que falla es el selector, no el flujo: la
búsqueda del campo y del botón se hace por capas (atributos, etiqueta, bloque
"Consultar por CDC", y recién al final el primer input visible).

## Estructura

| Archivo | Qué hace |
|---|---|
| `manifest.json` | MV3: content script, comando `Alt+C`, popup |
| `background.js` | service worker: validación, pestañas, bandeja |
| `src/cdc.js` | normalizar, validar (módulo 11) y descomponer el CDC |
| `src/content.js` | rellena, espera el captcha, consulta y detecta descargas |
| `popup.html` / `popup.js` | bandeja de CDC consultados |
| `GUIA-CAPTURA-RED.md` | cómo capturar el request de descarga con DevTools |

## Estado: la descarga del XML

Pendiente de confirmar. La documentación pública indica que la consulta
**pública** de e-Kuatia entrega estado, cabecera y totales, y que el XML
completo sólo se obtiene por el Web Service de SIFEN con certificado — pero
hay un reporte de que la propia pantalla de consulta ofrece descargar.

Antes de escribir el descargador hay que verificarlo. El procedimiento está en
[`GUIA-CAPTURA-RED.md`](GUIA-CAPTURA-RED.md).

### Plan previsto (3 piezas sueltas)

1. **Captura** — esta extensión (hecha, salvo la descarga).
2. **Descarga** — proceso local que toma una lista de CDC y guarda
   `xml/<CDC>.xml`. Si el XML sale de la web, se hace desde el navegador; si
   hace falta el WS de SIFEN, va con certificado desde un script (esa vía no
   tiene captcha: es SOAP sobre TLS mutuo, y responde `0422` con el XML cuando
   el documento está aprobado).
3. **Impresión** — visor local que lee la carpeta de XML e imprime o exporta a
   PDF.

## Créditos

- Composición y dígito verificador del CDC: Manual Técnico del SIFEN v150
  (DNIT), §10.1 y §10.2. Implementación de referencia consultada:
  [sifen-cdc](https://github.com/FindTek/sifen-cdc) (MIT).
- Resolución del reCAPTCHA: [CaptchaRaptor/captchaplugin](https://github.com/CaptchaRaptor/captchaplugin)
  (MIT), instalado como extensión independiente.
