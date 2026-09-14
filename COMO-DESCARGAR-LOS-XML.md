# Cómo descargar tus 4 XML — paso a paso

Guía para hacer todo desde cero, sin omitir pasos. Son unos 10 minutos.

Lo que vamos a hacer:

1. Actualizar la carpeta del proyecto.
2. Confirmar con el diagnóstico qué está pasando (1 comando).
3. Bajar los 4 XML, uno por uno, desde el portal.
4. Juntarlos en la carpeta `xml` y revisarlos (1 comando).

## Tus comprobantes

| # | CDC | Estado |
|---|---|---|
| 1 | `01800975120007008007180822026080217723517894` | ya bajado (18,8 KB) |
| 2 | `01800084314075001002930022026080517312520869` | falta |
| 3 | `01800922824011002005054622026080515870915429` | falta |
| 4 | `01800138767009017015703712026080813424535697` | falta |

---

## Paso 1 — Abrir la terminal en la carpeta correcta

1. Abrí el **Explorador de archivos** de Windows.
2. Andá al **Escritorio** y entrá a la carpeta **`ekuatia-chrome-v1`**.
3. Hacé clic una vez en la **barra de direcciones** (arriba, donde dice la ruta),
   borrá lo que hay, escribí `cmd` y apretá **Enter**.
4. Se abre una ventana negra. Arriba de todo tiene que decir:

   ```
   C:\Users\Jorge\Desktop\ekuatia-chrome-v1>
   ```

   Si dice otra ruta, repetí el paso 2 y 3 (el `cmd` se abre en la carpeta que
   estás viendo en ese momento).

---

## Paso 2 — Actualizar los archivos del proyecto

Escribí este comando y apretá **Enter**:

```cmd
git pull
```

- Si dice `Already up to date.` → perfecto, ya está.
- Si dice algo con `error: Your local changes...` → escribí `git stash` y después
  `git pull` de nuevo.
- Si dice `'git' is not recognized...` → tu copia no es un clon de git. En ese
  caso bajá de nuevo el ZIP desde acá, descomprimilo y copiá adentro tu
  `cdcs.txt`:
  <https://github.com/Jorgeeayala/ekuatia-chrome-v1/archive/refs/heads/arena/01a09d6c-ekuatia-chrome-v1.zip>

Ahora comprobá que están los archivos nuevos:

```cmd
dir tools
```

Tenés que ver estos nombres:

```
descargar-xml.js
diagnostico.js
red.js
resumen-xml.js
pruebas
```

Si falta `diagnostico.js` o `resumen-xml.js`, el `git pull` no trajo los cambios:
avisame antes de seguir.

---

## Paso 3 — Confirmar el diagnóstico

```cmd
node tools/diagnostico.js --entrada cdcs.txt
```

Tarda unos 20 segundos. Al final, en **Veredicto**, va a decir una de dos cosas:

**A) `CONFIRMADO: el portal sólo sirve el XML del CDC que fue consultado`**
→ Es el caso esperado. Seguí con el **Paso 4** (hay que consultar cada CDC).

**B) `Los dos CDC de la lista bajaron sin sesión`**
→ El 401 de tu corrida anterior fue un freno pasajero. Probá el lote completo
otra vez y, si bajan los 4, saltá al **Paso 6**:

```cmd
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml --pausa 4000
```

---

## Paso 4 — Bajar los XML uno por uno

Esto se repite **una vez por comprobante** (el #1 ya lo tenés). Por cada CDC son
5 clics y dura menos de un minuto.

### 4.1 Abrir el portal

En Chrome, andá a:

```
https://ekuatia.set.gov.py/consultas/
```

### 4.2 Pegar el CDC

En el recuadro que dice **"Ingrese CDC"** pegá el CDC del comprobante que toca.
Para el primero de la lista que te falta:

```
01800084314075001002930022026080517312520869
```

> Pegá con **Ctrl+V**. No le agregues espacios ni guiones: el portal quiere los
> 44 dígitos seguidos.

### 4.3 Resolver el captcha

1. Marcá el cuadro **"No soy un robot"**.
2. Esperá 5-10 segundos. Si te pide **imágenes** ("Seleccioná todos los
   semáforos", etc.), resolvelas; si no aparece nada, ya está.

### 4.4 Consultar

Hacé clic en **Consultar** y esperá unos segundos.

- Si aparece la **ficha del comprobante** (Resumen, Emisor, Receptor, Ítems…),
  seguí al paso 4.5.
- Si aparece **"CDC NO EXISTE"**, ese comprobante no tiene XML publicado
  (rechazado o inutilizado): anotá el CDC y pasá al siguiente.

### 4.5 Descargar el XML

Arriba de la ficha, a la derecha del número de CDC, están estos enlaces:

```
[ CDC: 0180…0869 ]   Nueva consulta   Imprimir   Descargar XML
```

Hacé clic en **Descargar XML**. El navegador guarda el archivo en tu carpeta de
**Descargas** con el nombre del CDC:

```
C:\Users\Jorge\Downloads\01800084314075001002930022026080517312520869.xml
```

### 4.6 Repetir con los demás

1. Clic en **Nueva consulta**.
2. Pegá el CDC #3: `01800922824011002005054622026080515870915429` → captcha →
   **Consultar** → **Descargar XML**.
3. Clic en **Nueva consulta**.
4. Pegá el CDC #4: `01800138767009017015703712026080813424535697` → captcha →
   **Consultar** → **Descargar XML**.

### Atajo opcional: hacerlo con la extensión

Si instalaste la extensión (`chrome://extensions` → **Modo de desarrollador** →
**Cargar descomprimida** → elegí `C:\Users\Jorge\Desktop\ekuatia-chrome-v1`),
el flujo es igual de corto y te guarda los archivos ordenados:

1. Clic en el ícono de la extensión (el rompecabezas de Chrome → chincheta).
2. Pegá el CDC y apretá **Agregar**. Repetilo con los 3 que faltan.
3. En cada fila: botón **Portal** → se abre la consulta con el CDC ya cargado →
   resolvés el captcha → volvés al popup → botón **XML**.
4. El archivo se guarda solo en `Descargas\e-Kuatia\xml\<CDC>.xml`.

---

## Paso 5 — Juntar los 4 XML en la carpeta del proyecto

En la terminal (la del Paso 1):

```cmd
mkdir xml 2>nul
move "%USERPROFILE%\Downloads\01800084314075001002930022026080517312520869.xml" xml
move "%USERPROFILE%\Downloads\01800922824011002005054622026080515870915429.xml" xml
move "%USERPROFILE%\Downloads\01800138767009017015703712026080813424535697.xml" xml
```

- `mkdir xml 2>nul` crea la carpeta `xml` si no existe (si ya existe, el mensaje
  de "Ya existe" es normal y no rompe nada).
- `%USERPROFILE%` es tu carpeta de usuario (`C:\Users\Jorge`), así el comando
  funciona tal cual.
- Si algún archivo se llamaba distinto (por ejemplo con `(1)` al final por una
  descarga repetida), mirá qué hay en Descargas con:

  ```cmd
  dir "%USERPROFILE%\Downloads\*.xml"
  ```

  y mové el que corresponda, ajustando el nombre en el `move`.

Si usaste la extensión, los archivos ya están en
`%USERPROFILE%\Downloads\e-Kuatia\xml\` y se copian con:

```cmd
copy "%USERPROFILE%\Downloads\e-Kuatia\xml\*.xml" xml
```

---

## Paso 6 — Revisar que quedaron bien

```cmd
node tools/resumen-xml.js xml
```

Vas a ver algo así (un bloque por archivo):

```
Revisando C:\Users\Jorge\Desktop\ekuatia-chrome-v1\xml

· 01800975120007008007180822026080217723517894.xml
  CDC        01800975120007008007180822026080217723517894
  Documento  Factura electrónica   Nº 007-008-0071808
  Emisor     RUC 80097512-0  ·  NEOMARKET SA
  Emisión    02/08/2026
  Contenido  18.8 KB · 4 ítem(s) · total 1.250.000 · IVA 113.636
  Firma      sí, el XML está firmado

4 archivo(s) XML  ·  4 con el documento completo
```

Lo que importa:

| Línea | Tiene que decir |
|---|---|
| `Contenido` | más de 2 KB y con ítems (los XML vacíos pesan menos de 1 KB) |
| `Firma` | `sí, el XML está firmado` |
| Al final | `4 archivo(s) XML · 4 con el documento completo` |

Si algún archivo dice **ATENCIÓN**, ese XML no sirve: borralo y volvé a bajarlo
con el Paso 4 (seguramente guardaste la página de error en lugar del XML).

---

## Paso 7 — Contarme cómo salió

Con esto me alcanza:

1. Lo que dijo el **Veredicto** del Paso 3 (las líneas del final).
2. La salida del **Paso 6** (`node tools/resumen-xml.js xml`).

Y decime si querés que el próximo mes esto se resuelva sin captchas: para eso
está el **WS de SIFEN con certificado CCFE**, que te armo en el mismo script
(misma lista de CDC, misma carpeta de salida).

---

## Si algo no sale

| Qué ves | Qué pasa | Qué hacer |
|---|---|---|
| `'node' is not recognized` | Node no está instalado o no está en el PATH | instalalo de <https://nodejs.org> (LTS), cerrá y abrí la terminal |
| `Cannot find module '...\tools\diagnostico.js'` | el `git pull` no trajo los archivos nuevos | repetí el Paso 2 y revisá el `dir tools` |
| `El CDC debe tener 44 dígitos` en el portal | se pegó cortado o con espacios | borrá el campo, copiá de nuevo el CDC completo (Ctrl+V) |
| El captcha no aparece | bloqueador o conexión | probá en una ventana de incógnito o recargá con F5 |
| **Descargar XML** no hace nada | la sesión venció | recargá la página (F5), consultá el CDC otra vez y volvé a tocar el botón |
| `error: HTTP 401` en el script | el portal sólo habilita el CDC consultado | es lo que resuelve el Paso 4 (consultarlo en el navegador) |
| `error: fetch failed` | sin internet o el portal caído | probá abrir <https://ekuatia.set.gov.py/consultas/> en Chrome |
| El `move` dice "No se puede encontrar el archivo" | el nombre del archivo en Descargas es distinto | `dir "%USERPROFILE%\Downloads\*.xml"` y ajustá el nombre |
