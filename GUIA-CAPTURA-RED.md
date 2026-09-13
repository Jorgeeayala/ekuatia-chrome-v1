# Guía: descubrir cómo e-Kuatia entrega la descarga

El objetivo es saber **qué devuelve exactamente la página** cuando consultás un
CDC y pulsás la opción de descarga: si es el XML del DTE, si es el KuDE en PDF,
o si la respuesta de la consulta ya trae el XML adentro.

Con eso escribo la descarga contra el endpoint real, en vez de adivinar.

---

## Opción A — con la extensión (2 minutos, alcanza para ubicar los controles)

Esta es la más rápida. La extensión ya trae un panel de diagnóstico.

1. En Chrome abrí `chrome://extensions` y activá **Modo de desarrollador**.
2. **Cargar descomprimida** → seleccioná la carpeta de este repositorio.
3. Andá a <https://ekuatia.set.gov.py/consultas/>
4. Seleccioná un CDC real en cualquier parte (un mail, un Excel, el KuDE en PDF)
   y hacé **clic derecho → "Buscar CDC en e-Kuatia"** (o `Alt+C`).
5. La extensión rellena el campo y espera a que el reCAPTCHA tenga token.
   **Dejá instalado y activo CaptchaRaptor**: es él quien resuelve el captcha.
   En cuanto haya token, la extensión pulsa *Consultar* sola.
6. Abajo a la derecha aparece un panel con el estado detectado y la lista de
   controles de descarga que encontró en la página.
7. Pulsá **"Copiar informe"** y pegame ese JSON.

Ese JSON me dice qué botones existen y cómo se llaman. No me dice la URL del
archivo: para eso está la Opción B.

---

## Opción B — con DevTools (la definitiva)

Es la que necesito para escribir el descargador. Son 8 pasos.

### Parte 1 — preparar

1. Andá a <https://ekuatia.set.gov.py/consultas/>
2. Abrí DevTools: `F12`, o `Ctrl+Shift+I` (`Cmd+Option+I` en Mac).
3. Elegí la pestaña **Network** (Red).
4. Marcá la casilla **Preserve log** (Preservar registro).
5. Dejá el filtro en **All** y, si querés menos ruido, escribí `xml` en el
   campo de filtro *después* de consultar (ver paso 8).

### Parte 2 — la consulta

6. Resolvé el reCAPTCHA, pegá un CDC real y pulsá **Consultar**.
7. En la lista de requests buscá el que trae el resultado de la consulta.
   Suele ser un `POST` a una ruta tipo `/consultas/...`. Clickealo y mirá la
   pestaña **Response**: ¿es JSON? Si es JSON, decime si adentro aparece
   la palabra `xml` (a veces el XML viaja dentro de la respuesta).

### Parte 3 — la descarga

8. **Sin cerrar DevTools**, hacé clic en el botón de descarga que ves en el
   resultado. Fijate qué request **nuevo** aparece al final de la lista.
9. Sobre ese request, clic derecho → **Copy** → y elegí una de estas:
   - **Copy link address** (si es un `GET`), o
   - **Copy as cURL** (si es un `POST`; trae método, URL y body juntos).
10. En ese mismo request, pestaña **Headers** → sección **Response Headers**,
    anotá el **`Content-Type`**. Es lo que define qué es el archivo:

| Content-Type | Qué es |
|---|---|
| `application/xml`, `text/xml` | ✅ el XML del DTE |
| `application/pdf` | el KuDE (representación gráfica) |
| `application/zip` | un paquete (varios archivos) |
| `application/json` | la respuesta de la consulta, no el archivo |

11. Si el request es un `POST`, abrí la pestaña **Payload** y copiame el cuerpo.

### Si no aparece ningún request nuevo

Entonces el archivo se arma **en el navegador** (una URL `blob:` generada con el
contenido que ya vino en la respuesta de la consulta). En ese caso:

- Volvé al request de la **consulta** y buscá en su **Response** la palabra
  `xml`. Si el XML está ahí, mejor todavía: no hace falta ningún request extra,
  alcanza con leer esa respuesta.
- Decime también si el botón de descarga era un `<a href="...">` o un
  `<button>` (el panel de la Opción A ya te muestra el tag).

---

## Qué enviarme

Con esto me alcanza:

```
Método:      GET  (o POST)
URL:         https://ekuatia.set.gov.py/...
Content-Type: application/xml  (o el que sea)
Body:        (sólo si es POST)
¿El request de la consulta traía "xml" en la respuesta? sí/no
```

⚠️ **No me mandes cookies ni tokens.** Si usás "Copy as cURL", el comando
incluye la cabecera `Cookie` y el token del reCAPTCHA: borrá esas partes antes
de pegarlo. El CDC en sí no es secreto (es público: cualquiera puede consultarlo).

---

## Mientras tanto

Lo que ya funciona y no depende de esta captura:

- validación del CDC (44 dígitos + dígito verificador módulo 11);
- rellenado del campo, espera del token del reCAPTCHA y clic en *Consultar*;
- bandeja de CDC consultados, exportable desde el popup.
