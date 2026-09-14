# Descarga del XML de un DTE por CDC

## El endpoint

```
GET https://ekuatia.set.gov.py/docs/documento-electronico-xml/<CDC>
```

Devuelve el XML completo y firmado del comprobante (`application/xml`), con el
emisor, el receptor, los ítems (`gCamItem`), los totales, el protocolo de
autorización y la firma digital.

**Pero ya no es anónimo.** Cualquier petición que no traiga la *sesión del
navegador* recibe **HTTP 401**. Esto es lo que hay que entender antes de
pelear con el script (ver *Si da 401*, más abajo).

## Comportamiento observado

| Caso | Respuesta |
|---|---|
| El CDC **que se consultó** en la pantalla (y por un rato después) | `200` + `application/xml` con el DTE completo (~10-40 KB) |
| Cualquier otro CDC | `401` (JSON con `mensaje`) |
| CDC inexistente, rechazado o inutilizado, ya consultado | `200` + HTML vacío: `<!doctype html><html><head></head><body></body></html>` |

### El "CDC consultado" (comportamiento comprobado el 14/09/2026)

Corrida real del usuario, con 4 CDC y **con** la sesión de su navegador copiada
(`--curl`):

```
✓ 01800975120007008007180822026080217723517894  18.8 KB   (el CDC que había consultado en Chrome)
! 01800084314075001002930022026080517312520869  error: HTTP 401
! 01800922824011002005054622026080515870915429  error: HTTP 401
! 01800138767009017015703712026080813424535697  error: HTTP 401
```

Mismo cliente, mismas cabeceras, misma sesión: **el único que bajó fue el CDC
consultado**. La sonda 5 de `tools/diagnostico.js` lo confirma con dos CDC
distintos: el consultado da `200 + XML` y el otro `401`, sin sesión de por medio.

Conclusión práctica: **el portal habilita el XML del comprobante que se consultó**
(con el captcha) y rechaza el resto. No es el User-Agent, ni la cookie, ni el
volumen.

Por eso **la respuesta siempre se valida antes de guardar**: si no empieza con
`<?xml` / `<rDE`, no se escribe el archivo. Si no se hiciera este control, los
CDC sin XML dejarían archivos `.xml` vacíos mezclados con los buenos.

## Si da 401 (el error `error: HTTP 401`)

### Antes de nada: puede ser transitorio

El portal está detrás de un **WAF** (las cookies que reparte son de F5 BIG-IP y
Dynatrace: `BIGipServer…`, `TS01…`, `dtCookie`, `rxVisitor`, `dtSa`), y ese WAF
frena con `401` a los clientes que no le gustan —por huella, por ráfaga o por
volumen— sin que el XML tenga nada de malo.

Comprobado en la práctica: una corrida con los cuatro CDC terminó en `HTTP 401`
y, minutos después, el mismo endpoint devolvió los cuatro XML (`HTTP 200 ·
application/xml`) **sin sesión y sin nada especial**. Es decir, el `401` puede
ser temporal. Antes de meterse en el resto de esta sección:

1. Volvé a correr la descarga, con más pausa:

   ```bash
   node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --pausa 4000
   ```

2. Ante un 401/403 el script ya abre la sesión una vez y, si vuelve a pasar,
   espera unos segundos y reintenta (el `401` a mitad de un lote suele ser el
   WAF, no el CDC).

Si con eso igual falla, seguí con lo de abajo.

### Si el 401 persiste

Significa: *el portal no te reconoce como una petición de su propia pantalla de
consultas*. No es un captcha mal resuelto ni un CDC inválido, y no se arregla
cambiando el User-Agent (aunque conviene mandarlo: el script ya lo hace).

Cómo funciona la descarga por dentro, según la propia pantalla de consultas:

```
/consultas/                     → el portal abre una sesión (cookie JSESSIONID)
   ↓  (captcha "No soy un robot" + 44 dígitos)
consulta del CDC                 → el portal guarda el DTE en esa sesión
   ↓
botón "Descargar XML"            → GET /docs/documento-electronico-xml/<CDC>
                                   con la cookie de esa sesión → 200 + XML
```

Sin esa cookie, el `GET` contesta 401 — y el propio portal, cuando le pasa,
avisa *"Tiempo de sesión finalizado. Realice una nueva consulta para la
descarga"*. Un script suelto en la terminal no tiene esa sesión: es el mismo
motivo por el que el reCAPTCHA está ahí.

### Paso 1 — Confirmarlo en un comando

```bash
node tools/diagnostico.js --entrada cdcs.txt
```

Corre ocho sondas contra el portal (cliente simple, cliente con cabeceras de
Chrome, con la cookie del warmup, la API JSON `POST /docs/documento-electronico`,
y las mismas con **tu** sesión si se la pasás), imprime un veredicto y guarda
todo en `diagnostico-401.txt`. Ese archivo es lo que hay que mirar (o pegar) para
decidir el camino.

### Paso 2 — Elegir el camino

Como el portal sólo entrega el XML del CDC que se consultó, la pregunta es
cuántos comprobantes son y si esto se repite:

**a) Pocos comprobantes, cada tanto (el caso de esta herramienta).**
Consultá cada CDC en el portal y bajá su XML. Por comprobante son tres pasos:
pegar el CDC, resolver el captcha, **Descargar XML**. La extensión lo hace más
cómodo: en el popup, cada fila tiene **Portal** (abre la consulta con el CDC ya
cargado) y **XML** (baja el archivo a `Descargas/e-Kuatia/xml/`). Si no usás la
extensión, alcanza con la propia pantalla del portal.

**b) Muchos comprobantes, todos los meses.** Ahí la web no es el camino: pasá al
**WS de SIFEN con certificado CCFE**
(`https://sifen.set.gov.py/de/ws/consultas/consulta-de.wsdl`, respuesta `0422`
con el XML completo). No depende de captchas, de cookies ni de consultar antes.
Es la vía oficial y la única pensable para automatizar en serio.

**c) Alternativa simple.** Pedirle los XML al emisor: la RG DNIT 06/2024 lo
obliga a entregárselos al receptor (normalmente por correo).

**d) La sesión del navegador (`--curl`) sirve sólo para el CDC consultado.** Es
útil si querés bajar ese XML por línea de comandos en vez de por el navegador:

```bash
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --curl captura-curl.txt
```

(con el CDC consultado como primera línea de `cdcs.txt`). Para los demás CDC,
igual hay que consultarlos. Y la sesión vence: cuando empiece a dar 401 de nuevo,
repetí la captura.

### Qué **no** sirve

- Cambiar el `User-Agent` solo: el 401 no es por el navegador, es por la sesión.
- Reintentar en bucle: el portal puede cortar por volumen y empeora el problema.
- El `--warmup` (visita `/consultas/` sin consultar el CDC): consigue la cookie
  de sesión, pero no la consulta; sirve cuando el portal acepta una sesión
  vacía y no cuando exige la consulta.

## Desde la línea de comandos (lotes)

```bash
# uno o varios CDC sueltos
node tools/descargar-xml.js 01800975120007008007180822026080217723517894

# un archivo con un CDC por línea
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml

# con nombre de archivo legible: AAAA-MM-DD_RUC-numero_CDC.xml
node tools/descargar-xml.js --entrada cdcs.txt --nombre-largo

# con la sesión del navegador (ver arriba)
node tools/descargar-xml.js --entrada cdcs.txt --curl captura-curl.txt

# ver qué contesta el servidor cuando algo no sale como se espera
node tools/descargar-xml.js --entrada cdcs.txt --debug
```

Opciones: `--salida` (carpeta), `--pausa` (ms entre descargas, por defecto 1200),
`--reintentos` (por defecto 3, con backoff ante 5xx y 429), `--navegador`
(cabeceras de Chrome, por defecto) / `--cliente-simple` (sólo `Accept`),
`--sin-warmup`, `--cookie`, `--cookie-archivo`, `--curl`, `--header`/`-H`,
`--api` (además del GET prueba `POST /docs/documento-electronico`),
`--base-url` (para pruebas).

Deja en la carpeta de salida:

| Archivo | Contenido |
|---|---|
| `<CDC>.xml` | los XML descargados |
| `no_encontrados.txt` | CDC válidos sin XML público |
| `no_validos.txt` | líneas que no son un CDC válido |
| `resumen.csv` | CDC, estado, bytes y archivo |

## Probar sin molestar al portal

Hay un servidor falso que imita los tres comportamientos del portal:

```bash
node tools/pruebas/mock-ekuatia.js            # el XML necesita la cookie de /consultas/
MOCK_MODO=publico  node tools/pruebas/mock-ekuatia.js   # el caso viejo (sin sesión)
MOCK_MODO=consulta node tools/pruebas/mock-ekuatia.js   # exige haber consultado ese CDC
```

Y en otra terminal:

```bash
node tools/descargar-xml.js --base-url http://127.0.0.1:8099 01800975120007008007180822026080217723517894
node tools/diagnostico.js   --base-url http://127.0.0.1:8099 01800975120007008007180822026080217723517894
```

## Cortesía y límites

El endpoint es público y no documenta una cuota. Para no parecer un crawler:

- el script espera **1,2 s** entre descargas;
- la extensión también pausa entre una y otra;
- los reintentos usan backoff exponencial.

## Advertencia

Es un endpoint interno del portal: cambia sin aviso (de hecho, el 401 actual es
uno de esos cambios). Si en algún momento deja de servir del todo, el respaldo
es el **WS de SIFEN** (`https://sifen.set.gov.py/de/ws/consultas/consulta-de.wsdl`),
que da el mismo XML con `0422` pero exige certificado CCFE con TLS mutuo.
