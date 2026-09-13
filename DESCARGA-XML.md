# Descarga del XML de un DTE por CDC

## El endpoint

```
GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>
```

Devuelve **el XML completo y firmado del comprobante** (`application/xml`), con
el emisor, el receptor, los ítems (`gCamItem`), los totales, el protocolo de
autorización y la firma digital.

**No necesita certificado, ni sesión, ni reCAPTCHA, ni navegador.** Es el mismo
recurso que usa el botón de descarga de la pantalla de consulta, pero se puede
pedir directo. Esto deja afuera del camino al WS de SIFEN (que exige CCFE con
TLS mutuo) y al captcha (que exige resolverlo en el iframe de Google).

## Comportamiento verificado

| Caso | Respuesta |
|---|---|
| CDC existente y aprobado | `application/xml` con el DTE completo (~10-40 KB) |
| CDC inexistente, rechazado o inutilizado | `200` con un HTML **vacío**: `<!doctype html><html><head></head><body></body></html>` |
| CDC con dígito verificador inválido | ídem: HTML vacío |

Por eso **la respuesta siempre se valida antes de guardar**: si no empieza con
`<?xml` / `<rDE`, no se escribe el archivo. Si no se hiciera este control, los
CDC sin XML dejarían archivos `.xml` vacíos mezclados con los buenos.

## Cómo se usa en este repo

### Desde la extensión

- Seleccionás un CDC en cualquier página → clic derecho → **"Descargar XML del
  CDC (e-Kuatia)"**, o `Alt+X`.
- O pegás el CDC en el popup y pulsás **Descargar XML**.
- Los archivos quedan en `Descargas/e-Kuatia/xml/<CDC>.xml`.
- El popup muestra el estado de cada uno: *descargado*, *sin XML* o *error*.

Si Chrome tiene activada la opción *"Preguntar dónde guardar cada archivo"*,
va a aparecer el diálogo igual: se desactiva en
`chrome://settings/downloads`.

### Desde la línea de comandos (lotes)

Para muchos comprobantes conviene el script, que no depende del navegador:

```bash
# uno o varios CDC sueltos
node tools/descargar-xml.js 01800975120007008007180822026080217723517894

# un archivo con un CDC por línea
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml

# con nombre de archivo legible: AAAA-MM-DD_RUC-numero_CDC.xml
node tools/descargar-xml.js --entrada cdcs.txt --nombre-largo
```

Opciones: `--salida` (carpeta), `--pausa` (ms entre descargas, por defecto
1200), `--reintentos` (por defecto 3, con backoff ante 5xx y 429).

Deja en la carpeta de salida:

| Archivo | Contenido |
|---|---|
| `<CDC>.xml` | los XML descargados |
| `no_encontrados.txt` | CDC válidos sin XML público |
| `no_validos.txt` | líneas que no son un CDC válido |
| `resumen.csv` | CDC, estado, bytes y archivo |

## Cortesía y límites

El endpoint es público y no documenta una cuota. Para no parecer un crawler:

- el script espera **1,2 s** entre descargas;
- la extensión también pausa entre una y otra;
- los reintentos usan backoff exponencial.

## Advertencia

Es un endpoint interno del portal: puede cambiar sin aviso. Si en algún momento
empieza a devolver HTML vacío para todo, el respaldo es el **WS de SIFEN**
(`https://sifen.set.gov.py/de/ws/consultas/consulta-de.wsdl`), que da el mismo
XML con `0422` pero exige certificado CCFE con TLS mutuo.
