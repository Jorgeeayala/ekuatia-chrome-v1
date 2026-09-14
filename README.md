# Descargar XML de e-Kuatia (CDC)

Dos herramientas para bajar el **XML de un comprobante electrónico** de
[e-Kuatia](https://ekuatia.set.gov.py/consultas/) (SIFEN, DNIT Paraguay) a
partir del **CDC** — el Código de Control de 44 dígitos que figura en el KuDE:

- una **extensión de Chrome** (MV3) que descarga desde el navegador, donde vive
  la sesión del portal;
- un **script de línea de comandos** (`tools/descargar-xml.js`) para lotes, sin
  dependencias (Node 18+).

```
/consultas/  →  consulta del CDC (captcha)  →  sesión del portal
                                                    ↓
                     GET /docs/documento-electronico-xml/<CDC>  →  XML
```

## Lo que hay que saber antes de empezar (el 401)

**El endpoint dejó de ser anónimo.** En 2026 el portal empezó a contestar
`HTTP 401` a las peticiones que no traen la **sesión del navegador**: la misma
que la pantalla de consultas abre al consultar un CDC (con el reCAPTCHA "No soy
un robot" y las cookies del portal).

- El 401 **no** es un CDC inválido, ni un captcha sin resolver en el script, ni
  un error de configuración: es el portal pidiendo su sesión.
- **Y lo más importante (comprobado)**: el portal entrega el XML **del CDC que
  fue consultado** en su pantalla y `401` para los demás, aunque mandes la
  sesión del navegador. En una corrida real de 4 CDC, bajó sólo el consultado.
  O sea: para varios comprobantes hay que consultar cada uno (captcha) — o pasar
  al WS de SIFEN con certificado CCFE. El diagnóstico lo confirma con dos CDC
  distintos. Ver [`DESCARGA-XML.md`](DESCARGA-XML.md) → *"El CDC consultado"*.
- La extensión lo tiene más fácil porque corre dentro del navegador (manda las
  cookies). El script manda cabeceras de Chrome y, ante un 401, abre la sesión
  en `/consultas/`, espera y reintenta; si el portal exige la consulta previa,
  se le puede pasar la sesión del navegador con `--curl` o `--cookie`.

Todo el detalle, la evidencia y los cuatro caminos posibles están en
[`DESCARGA-XML.md`](DESCARGA-XML.md) → *"Si da 401"*.

### Diagnóstico en un comando

```bash
node tools/diagnostico.js --entrada cdcs.txt
```

Corre ocho sondas contra el portal, dice qué está pasando y guarda todo en
`diagnostico-401.txt`.

## Instalación de la extensión

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
rechazado o inutilizado), *error* o *pendiente*. Si el portal contesta 401, el
chip *error* explica que hay que abrir la sesión en la pantalla de consultas
(pasá el mouse por encima).

Los archivos quedan en `Descargas/e-Kuatia/xml/<CDC>.xml`.

## Descarga en lote, sin navegador

```bash
# uno o varios CDC sueltos
node tools/descargar-xml.js 01800975120007008007180822026080217723517894

# un archivo con un CDC por línea
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml

# nombre legible: AAAA-MM-DD_RUC-numero_CDC.xml
node tools/descargar-xml.js --entrada cdcs.txt --nombre-largo

# con la sesión copiada del navegador ("Copy as cURL" de la descarga)
node tools/descargar-xml.js --entrada cdcs.txt --curl captura-curl.txt

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

## Probarlo

- Guía paso a paso con los tres casos de prueba (CDC real, inexistente y con
  dígito verificador roto), verificación del XML y solución de problemas:
  [`PRUEBA-PASO-A-PASO.md`](PRUEBA-PASO-A-PASO.md).
- Para probar **sin tocar el portal** hay un servidor falso que imita los tres
  comportamientos del endpoint:

  ```bash
  node tools/pruebas/mock-ekuatia.js                     # el XML necesita la cookie de /consultas/
  MOCK_MODO=publico  node tools/pruebas/mock-ekuatia.js   # el caso viejo, sin sesión
  MOCK_MODO=consulta node tools/pruebas/mock-ekuatia.js   # exige haber consultado ese CDC
  ```

  y en otra terminal, con `--base-url http://127.0.0.1:8099`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `manifest.json` | MV3: atajos `Alt+X` / `Alt+C`, popup, permisos |
| `background.js` | service worker: valida el CDC y descarga el XML con la sesión del navegador |
| `src/cdc.js` | normalizar, validar (módulo 11) y descomponer el CDC |
| `popup.html` / `popup.js` | bandeja de CDC, descargas y avance |
| `tools/descargar-xml.js` | descarga en lote desde la línea de comandos |
| `tools/diagnostico.js` | ocho sondas + veredicto del 401 (`diagnostico-401.txt`) |
| `tools/red.js` | cabeceras de navegador, cookies y lector de "Copy as cURL" |
| `tools/pruebas/mock-ekuatia.js` | servidor falso para probar sin red |
| `DESCARGA-XML.md` | el endpoint, el 401, qué camino tomar y el plan B |

## Créditos

Composición y dígito verificador del CDC: Manual Técnico del SIFEN v150 (DNIT),
§10.1 y §10.2. Implementación de referencia consultada:
[sifen-cdc](https://github.com/FindTek/sifen-cdc) (MIT).
