# Descargar XML de e-Kuatia (CDC)

Extensión de Chrome (Manifest V3) que descarga el **XML de un comprobante
electrónico** de [e-Kuatia](https://ekuatia.set.gov.py/consultas/) (SIFEN, DNIT
Paraguay) a partir del **CDC** — el Código de Control de 44 dígitos que figura
en el KuDE.

Seleccionás el CDC en cualquier página y la extensión baja el XML a
`Descargas/e-Kuatia/xml/<CDC>.xml`.

## Por qué no hace falta certificado ni captcha

```
GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>  →  application/xml
```

Ese endpoint devuelve el DTE completo y firmado. Es público: no exige
certificado CCFE (como el WS de SIFEN), ni sesión, ni resolver el reCAPTCHA de
la pantalla de consulta. Todo documentado en
[`DESCARGA-XML.md`](DESCARGA-XML.md), incluido el caso trampa: cuando el CDC no
tiene XML público el servidor responde `200` con un **HTML vacío**, así que la
respuesta se valida antes de guardar y nunca se escribe un `.xml` vacío.

## Instalación

1. `chrome://extensions` → activar **Modo de desarrollador**
2. **Cargar descomprimida** → seleccionar esta carpeta
3. Si tenés activada la opción *"Preguntar dónde guardar cada archivo"*,
   conviene desactivarla en `chrome://settings/downloads` para que los XML
   bajen solos a su carpeta.

## Uso

| Acción | Cómo |
|---|---|
| Descargar un XML | seleccionar el CDC → clic derecho → *Descargar XML del CDC*, o `Alt+X` (o `Alt+C`) |
| Descargar varios | ícono de la extensión → *Descargar XML* / *Sólo pendientes* |
| Cargar un CDC a mano | pegarlo en el popup → *Agregar* |

El CDC se acepta con espacios, puntos o guiones (el KuDE lo imprime en grupos
de cuatro) y se valida: 44 dígitos y **dígito verificador módulo 11** según el
Manual Técnico del SIFEN v150 §10.1 y §10.2. Si el dígito no cierra, avisa con
una `!` roja y no descarga nada.

El popup muestra el estado de cada CDC: *descargado*, *sin XML* (inexistente,
rechazado o inutilizado), *error* o *pendiente*.

## Descarga en lote, sin navegador

Para muchos comprobantes conviene el script, que no depende de Chrome:

```bash
# uno o varios CDC sueltos
node tools/descargar-xml.js 01800975120007008007180822026080217723517894

# un archivo con un CDC por línea
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml

# nombre legible: AAAA-MM-DD_RUC-numero_CDC.xml
node tools/descargar-xml.js --entrada cdcs.txt --nombre-largo

# ver qué responde el servidor cuando algo no sale como se espera
node tools/descargar-xml.js --entrada cdcs.txt --debug
```

Sin dependencias (Node 18+). Deja en la carpeta de salida:

| Archivo | Contenido |
|---|---|
| `<CDC>.xml` | los XML descargados |
| `no_encontrados.txt` | CDC válidos sin XML público |
| `no_validos.txt` | líneas que no son un CDC válido |
| `resumen.csv` | CDC, estado, bytes y archivo |

Hay una pausa de 1,2 s entre descargas y reintentos con backoff ante errores
de red: el endpoint es público y no conviene parecer un crawler.

## Estructura

| Archivo | Qué hace |
|---|---|
| `manifest.json` | MV3: atajos `Alt+X` / `Alt+C`, popup, permisos |
| `background.js` | service worker: valida el CDC y descarga el XML |
| `src/cdc.js` | normalizar, validar (módulo 11) y descomponer el CDC |
| `popup.html` / `popup.js` | bandeja de CDC, descargas y avance |
| `tools/descargar-xml.js` | descarga en lote desde la línea de comandos |
| `DESCARGA-XML.md` | el endpoint, su comportamiento y el plan B |

## Advertencia

El endpoint es interno del portal y no está documentado: puede cambiar sin
aviso. Si algún día empieza a devolver HTML vacío para todo, el respaldo es el
**WS de SIFEN** (`https://sifen.set.gov.py/de/ws/consultas/consulta-de.wsdl`),
que da el mismo XML respondiendo `0422`, pero exige certificado CCFE con TLS
mutuo.

## Créditos

Composición y dígito verificador del CDC: Manual Técnico del SIFEN v150 (DNIT),
§10.1 y §10.2. Implementación de referencia consultada:
[sifen-cdc](https://github.com/FindTek/sifen-cdc) (MIT).
