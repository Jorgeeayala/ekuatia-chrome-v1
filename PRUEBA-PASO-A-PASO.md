# Prueba paso a paso

Objetivo: confirmar que la descarga real funciona contra el servidor de la SET,
con **tres** CDC de prueba que cubren los tres caminos posibles.

| # | CDC | Para qué sirve | Resultado esperado |
|---|---|---|---|
| 1 | uno **real** tuyo (el que ya usamos, u otro de una factura tuya) | el caso bueno | `✓ descargado` + un `.xml` |
| 2 | `01444444017001001001452822017012515873260988` | CDC con formato correcto que no existe en SIFEN | `· sin XML público` |
| 3 | el mismo CDC real pero con el **último dígito cambiado** | el dígito verificador no cierra | `✗ no válido` |

Si los tres dan el resultado esperado, la herramienta está validada y podés
mandarle la carpeta a tu app.

---

## Parte 0 — Preparar

### 0.1 ¿Tenés Node?

```bash
node --version
```

Tiene que decir `v18.x` o más alto (`v20`, `v22`…). Si dice *"no se reconoce el
comando"* o da `v14`/`v16`, instalalo de <https://nodejs.org> (la versión LTS) y
cerrá y volvé a abrir la terminal.

### 0.2 Bajar el código

Si no lo tenés:

```bash
git clone -b arena/01a09d6c-ekuatia-chrome-v1 https://github.com/Jorgeeayala/ekuatia-chrome-v1.git
cd ekuatia-chrome-v1
```

Si ya lo tenés clonado:

```bash
git fetch origin
git checkout arena/01a09d6c-ekuatia-chrome-v1
git pull
```

---

## Parte 1 — Probar el script (el camino importante)

### Paso 1. Armá el archivo de prueba

Creá un archivo `cdcs.txt` en la carpeta del repo con **un CDC por línea**.
Podés usar el Bloc de notas o VS Code. Ejemplo (reemplazá la primera línea por
un CDC real tuyo):

```text
01800975120007008007180822026080217723517894
01444444017001001001452822017012515873260988
01800975120007008007180822026080217723517895
```

> La primera línea es un CDC real. La segunda tiene formato válido pero no
> existe. La tercera es el mismo CDC real con el último dígito alterado (el
> verificador no cierra), para comprobar que la validación lo rechaza **antes**
> de gastar una petición.

Se aceptan espacios, puntos o guiones, así que podés pegar el CDC tal cual lo
imprime el KuDE.

### Paso 2. Corré la descarga

```bash
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --debug
```

Deberías ver algo así, con una pausa de ~1,2 s entre cada uno (si en cambio ves
`error: HTTP 401`, andá directo a la *Parte 3.1*):

```
    [debug] HTTP 200 · application/xml · <?xml version="1.0" ...
✓ 01800975120007008007180822026080217723517894  28.4 KB  →  ./xml/01800975120007008007180822026080217723517894.xml
    [debug] HTTP 200 · text/html · <!doctype html><html>...
· 01444444017001001001452822017012515873260988  sin XML público
✗ no válido     01800975120007008007180822026080217723517895

Descargados: 1 | sin XML público: 1 | con error: 0 | no válidos: 1
Carpeta: /ruta/a/ekuatia-chrome-v1/xml
```

### Paso 3. Mirá qué se generó

```bash
# Linux / macOS
ls -la ./xml
cat ./xml/resumen.csv
cat ./xml/no_encontrados.txt
cat ./xml/no_validos.txt

# Windows (PowerShell)
dir .\xml
type .\xml\resumen.csv
type .\xml\no_encontrados.txt
type .\xml\no_validos.txt
```

Esperado: **un** archivo `.xml` (el del CDC real), `no_encontrados.txt` con el
CDC #2, `no_validos.txt` con el #3, y `resumen.csv` con las tres filas.

### Paso 4. Verificá que el XML sea el correcto

Abrí el `.xml` de dos maneras:

- **En Chrome**: arrastrá el archivo a una pestaña. Chrome muestra el árbol XML
  y, si algo está roto, lo dice arriba.
- **En un editor** (VS Code, Bloc de notas++): la primera línea tiene que ser
  `<?xml version="1.0"`.

Dentro del archivo tiene que estar:

| Buscá | Qué es |
|---|---|
| `<rDE` | la raíz: es un documento electrónico |
| `dNumDoc` o `0071808` | el número del comprobante |
| `NEOMARKET` (o el emisor de tu factura) | el RUC y razón social del emisor |
| `gCamItem` | los ítems, uno por cada línea de la factura |
| `<Signature` | la firma digital (el documento está firmado) |

Si ves los ítems y la firma, el XML es el bueno y ya se lo podés pasar a tu app.

### Paso 5. Probá con más CDC reales

Cuando el paso anterior salga bien, armá un `cdcs.txt` con 10 o 20 CDC reales y
repetí el comando. Fijate que el conteo final cierre con la cantidad de
comprobantes que esperabas.

---

## Parte 2 — Probar la extensión (opcional)

Sirve para el caso de "estoy mirando una factura y quiero bajar el XML ahora".

### Paso 1. Cargala

1. En Chrome: `chrome://extensions`
2. Activá **Modo de desarrollador** (arriba a la derecha)
3. **Cargar descomprimida** → seleccioná la carpeta `ekuatia-chrome-v1`
4. Debería aparecer como **"Descargar XML de e-Kuatia (CDC)"** v1.3

### Paso 2. Desactivá el diálogo de descarga

En `chrome://settings/downloads`, desactivá **"Preguntar dónde guardar cada
archivo antes de descargar"**. Si lo dejás activado, cada XML te va a preguntar
dónde va.

### Paso 3. Probá los tres caminos

- **Menú contextual**: abrí `cdcs.txt` en Chrome (arrastralo a una pestaña),
  seleccioná un CDC con el mouse → clic derecho → *Descargar XML del CDC*.
- **Atajo**: en cualquier página normal (no `chrome://`), seleccioná un CDC y
  pulsá `Alt+X` (o `Alt+C`).
- **Popup**: hacé clic en el ícono de la extensión, pegá un CDC y pulsá
  *Agregar*; después *XML* en esa fila, o *Descargar XML* para toda la bandeja.

Mirá el **badge del ícono**:

| Badge | Significado |
|---|---|
| `✓` verde | XML descargado |
| `·` ámbar | el CDC no tiene XML público |
| `!` rojo | CDC inválido, o no se pudo leer la selección |

### Paso 4. Revisá dónde quedaron

Los archivos van a `Descargas/e-Kuatia/xml/<CDC>.xml`. En Windows:
`C:\Users\<tu usuario>\Downloads\e-Kuatia\xml\`.

---

## Parte 3 — Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `✗ no válido` con un CDC que sabés que existe | está mal copiado (falta o sobra un dígito) | pegalo y comparalo con el KuDE; o validalo con el comando de abajo |
| Todos dicen `sin XML público` | el endpoint cambió, o caíste en un bloqueo por volumen | corré con `--debug`: si el `HTTP` no es `200` o el content-type no es `text/html`, **mandame esa línea** |
| `! <CDC> error: HTTP 401` | el portal exige su **sesión**: el endpoint ya no es anónimo | mirá *Parte 3.1* acá abajo: `node tools/diagnostico.js --entrada cdcs.txt` y después `--curl`/`--cookie` con la sesión del navegador |
| `fetch failed` / `ENOTFOUND` | sin internet, o el DNS no resuelve `ekuatia.set.gov.py` | probá abrir el sitio en el navegador |
| `EACCES` / `no such file or directory` | no puede escribir en la carpeta de salida | usá otra: `--salida ./xml2` |
| La extensión no hace nada | el service worker quedó viejo | en `chrome://extensions` tocá el botón de recargar (⟳) de la extensión |
| `Alt+X` no responde | el atajo está en conflicto, o la página es especial | revisalo en `chrome://extensions/shortcuts`; y probá en una página `https://` normal |
| `Alt+X` en un PDF no lee la selección | el visor de PDF de Chrome no expone la selección al script | usá el menú contextual o el popup |

### 3.1 El caso `HTTP 401`

Comprobado el 14/09/2026: **el portal sólo entrega el XML del CDC que fue
consultado** en la pantalla de consultas; para los demás contesta `401` aunque
le mandes las cabeceras y la sesión del navegador. En una corrida real de 4 CDC
bajó el primero (el que se había consultado) y los otros tres dieron 401.

Confirmalo con:

```bash
node tools/diagnostico.js --entrada cdcs.txt
```

La sonda 5 prueba dos CDC distintos: si el primero baja y el segundo da 401, el
veredicto lo dice con todas las letras. Y entonces:

| Cuántos son | Qué hacer |
|---|---|
| Pocos | Consultá cada CDC en <https://ekuatia.set.gov.py/consultas/> (captcha) y bajá su XML. Con la extensión: botón **Portal** en la fila → captcha → botón **XML** |
| Muchos o periódicos | WS de SIFEN con certificado CCFE (`consulta-de.wsdl`) |
| Alternativa | Pedirle los XML al emisor: la RG DNIT 06/2024 lo obliga |

Más detalle en [`DESCARGA-XML.md`](DESCARGA-XML.md) → *"El CDC consultado"*.

Para validar un CDC suelto sin descargarlo:

```bash
node -e "const c=require('./src/cdc.js');const a=c.analizarCdc(process.argv[1]);console.log((a.valido?'VALIDO':'INVALIDO')+'  '+a.cdc+'  '+a.tipoDocumentoNombre+'  RUC '+a.rucEmisor+'-'+a.dvRucEmisor+'  Nº '+a.establecimiento+'-'+a.puntoExpedicion+'-'+a.numeroDocumento+'  fecha '+a.fechaEmision)" 01800975120007008007180822026080217723517894
```

---

## Parte 4 — Qué mandarme

Cuando termines, con esto me alcanza para cerrar:

1. La **salida completa** de la corrida (la podés pegar tal cual).
2. Si aparece `error: HTTP 401`: el archivo `diagnostico-401.txt` que deja
   `node tools/diagnostico.js --entrada cdcs.txt`.
3. Si algún CDC real salió como `sin XML público`: la línea `[debug]` de ese
   caso.
4. Si querés que ajuste algo de la salida para tu app: el **nombre de archivo**
   y la **estructura de carpetas** que espera (¿lee todos los `.xml` de una
   carpeta? ¿necesita algún índice?).

Con eso doy por terminada la herramienta y seguís vos con tu app.
