# Buscar CDC en e-Kuatia

Extensión de Chrome (Manifest V3) para trabajar con comprobantes electrónicos
de [e-Kuatia](https://ekuatia.set.gov.py/consultas/) (SIFEN, DNIT Paraguay) a
partir del **CDC** — el Código de Control de 44 dígitos que figura en el KuDE.

Hace dos cosas:

1. **Descarga el XML del comprobante** directamente, sin certificado, sin
   sesión y sin reCAPTCHA. Es el camino principal.
2. **Consulta la web de e-Kuatia** (rellena el campo, espera el token del
   reCAPTCHA y pulsa *Consultar*), para ver el estado y el KuDE en pantalla.

## Instalación

1. `chrome://extensions` → activar **Modo de desarrollador**
2. **Cargar descomprimida** → seleccionar esta carpeta
3. Si Chrome tiene activada la opción *"Preguntar dónde guardar cada archivo"*,
   conviene desactivarla en `chrome://settings/downloads` para que los XML
   bajen solos a `Descargas/e-Kuatia/xml/`.

Para el camino 1 no hace falta nada más. Para el camino 2 hace falta que el
reCAPTCHA quede resuelto: se recomienda instalar
[CaptchaRaptor](https://github.com/CaptchaRaptor/captchaplugin) cargando su
carpeta `extension/`. Es una **extensión aparte** — resuelve el captcha dentro
del iframe de Google; esta extensión sólo espera a que el token aparezca.

## Uso

| Acción | Cómo |
|---|---|
| Descargar el XML | seleccionar el CDC → clic derecho → *Descargar XML del CDC*, o `Alt+X` |
| Consultar en la web | seleccionar el CDC → clic derecho → *Consultar CDC en e-Kuatia (web)*, o `Alt+C` |
| Ver la bandeja y descargar | ícono de la extensión |

El CDC se acepta con espacios, puntos o guiones (el KuDE lo imprime en grupos
de cuatro) y se valida: 44 dígitos y **dígito verificador módulo 11** según el
Manual Técnico del SIFEN v150 §10.1 y §10.2. Si el dígito no cierra, avisa con
una `!` roja y no hace nada.

## La descarga del XML

```
GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>  →  application/xml
```

Devuelve el DTE completo y firmado. Detalle importante: cuando el CDC no tiene
XML público responde `200` con un **HTML vacío**, así que la respuesta se
valida antes de guardar — nunca se escribe un `.xml` vacío. Todo documentado en
[`DESCARGA-XML.md`](DESCARGA-XML.md).

### En lote, sin navegador

```bash
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml
```

Deja los XML, `no_encontrados.txt`, `no_validos.txt` y `resumen.csv`. Sin
dependencias (Node 18+).

## Estructura

| Archivo | Qué hace |
|---|---|
| `manifest.json` | MV3: content script, comandos `Alt+C` / `Alt+X`, popup |
| `background.js` | service worker: valida, descarga y consulta |
| `src/cdc.js` | normalizar, validar (módulo 11) y descomponer el CDC |
| `src/content.js` | rellena la web, espera el captcha y consulta |
| `popup.html` / `popup.js` | bandeja de CDC y descargas |
| `tools/descargar-xml.js` | descarga en lote desde la línea de comandos |
| `DESCARGA-XML.md` | el endpoint, su comportamiento y cómo usarlo |

## Cómo funciona la consulta web

```
selección de texto
   └─► background.js: extrae un CDC de 44 dígitos y lo valida (módulo 11)
        └─► reutiliza la pestaña de e-Kuatia, o abre /consultas/ (con límite de espera)
             └─► content.js:
                  1. localiza el campo "Ingrese CDC" y lo rellena
                     (setter nativo de `value`, para que Angular lo registre)
                  2. si la página tiene reCAPTCHA, espera el token (hasta 90 s)
                  3. pulsa "Consultar"
                  4. espera el resultado y enumera los controles de descarga
```

La búsqueda del campo y del botón se hace por capas (atributos, etiqueta,
bloque "Consultar por CDC", y recién al final el primer input visible): si el
sitio cambia el DOM, falla el selector, no todo el flujo.

## Próximo paso

Pendiente: **parsear los XML descargados e imprimirlos o exportarlos a PDF**
(réplica del KuDE, ticket térmico o planilla resumida).

## Créditos

- Composición y dígito verificador del CDC: Manual Técnico del SIFEN v150
  (DNIT), §10.1 y §10.2. Implementación de referencia consultada:
  [sifen-cdc](https://github.com/FindTek/sifen-cdc) (MIT).
- Resolución del reCAPTCHA: [CaptchaRaptor/captchaplugin](https://github.com/CaptchaRaptor/captchaplugin)
  (MIT), como extensión independiente.
