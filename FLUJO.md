# Flujo de la herramienta y ¿es funcional?

Este documento explica qué hace la herramienta por dentro, paso a paso, y qué
parte de eso está **probada** y qué parte todavía no. Sin adornos: al final está
la lista de lo que puede fallar y lo que no promete.

## Las dos piezas

| Pieza | Dónde corre | Para qué sirve |
|---|---|---|
| **Extensión** (`manifest.json`, `background.js`, `popup.js`, `src/cdc.js`) | Chrome | Bajar el XML en el momento, mientras mirás una factura. Usa la sesión del navegador. |
| **Script** (`tools/*.js`) | Node en la terminal | Bajar varios comprobantes de una lista (`cdcs.txt`), sin navegador ni clics. |

Las dos comparten la misma validación del CDC (`src/cdc.js`) y el mismo endpoint.

---

## Flujo de la extensión

```
seleccionás un CDC  →  clic derecho / Alt+X / popup
        │
        ▼
  src/cdc.js: extraerCdc() + validarCdc()        ← 44 dígitos + módulo 11, sin red
        │  (si el dígito verificador no cierra: badge rojo, no se pide nada al portal)
        ▼
  background.js: registrar()                      ← bandeja en chrome.storage.local
        │
        ▼
  verificarXml(cdc)
        ├── GET /docs/documento-electronico-xml/<CDC>   (credentials: include)
        │       │
        │       ├── 200 + XML          → listo
        │       ├── 200 + HTML vacío   → "sin XML público" (rechazado/inutilizado)
        │       ├── 401/403 ──────────► pedirXmlDesdeLaPagina(): repite el GET
        │       │                       desde una pestaña del portal, donde la
        │       │                       cookie de sesión viaja siempre
        │       └── otro              → error con el código
        ▼
  guardarXml(): chrome.downloads.download del TEXTO ya validado
        │       (Descargas/e-Kuatia/xml/<CDC>.xml; si el navegador rechazara
        │        la descarga del texto, cae a descargar por URL)
        ▼
  bandeja + badge (✓ verde / · ámbar / ! rojo) y chip en el popup
```

Detalles que importan:

- **La validación del CDC es local**: un CDC mal copiado se rechaza sin gastar
  una petición, y el mensaje dice cuál es el problema.
- **El XML se guarda como se validó**: no se vuelve a pedir para descargar, así
  no puede quedar en disco una página de error con extensión `.xml`.
- **El plan B de la pestaña** existe por una razón concreta: una petición hecha
  desde la extensión puede quedar sin la cookie de sesión (política *SameSite*
  del navegador), mientras que la misma petición hecha **dentro** de
  `ekuatia.set.gov.py` la lleva siempre.
- **El botón `Portal`** del popup abre `/consultas/<CDC>` para resolver el
  captcha cuando el portal exige consultar el comprobante antes de habilitar su
  descarga.

---

## Flujo del script

```
cdcs.txt  (un CDC por línea; acepta espacios, puntos o guiones)
        │
        ▼
  1. Validación local de cada línea                 ← sin red; los inválidos quedan en no_validos.txt
        │
        ▼
  2. Warmup en /consultas/ (opcional)               ← guarda la cookie de sesión, si el portal la da
        │
        ▼
  ┌── 3. Primera pasada: un GET por CDC ─────────────────────────────────────┐
  │     200 + XML          → guardar en ./xml/<CDC>.xml                      │
  │     200 + HTML vacío   → no_encontrados.txt                              │
  │     401/403            → abrir sesión y reintentar; si sigue, esperar    │
  │                          3 s, 6 s… y reintentar                          │
  │     429 / 5xx / red    → backoff exponencial                             │
  └──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  4. Segunda pasada SÓLO para los CDC con error transitorio (401/red):
     espera 10 s y los reintenta una vez.        ← los rechazos por ráfaga del WAF
        │                                            dejan de costar comprobantes
        ▼
  5. Salidas en la carpeta:
       <CDC>.xml · no_encontrados.txt · no_validos.txt · resumen.csv
        │
        ▼
  6. Verificación:  node tools/resumen-xml.js xml
       (CDC, tipo, número, emisor, fecha, ítems, totales, firma digital)
```

---

## ¿Es funcional? Qué está probado y qué no

### Probado con evidencia

| Qué | Cómo se probó |
|---|---|
| Validación del CDC (44 dígitos + módulo 11) | `node tools/pruebas/auto.js` + tus 4 comprobantes reales |
| Descarga por script | tu corrida: **4 de 4** XML, y los 4 verificados desde acá contra el portal |
| Detección de "sin XML público" | contra el servidor falso (200 + HTML vacío → no se escribe ningún `.xml`) |
| Reintento de los 401 por ráfaga | contra el servidor falso en modo `flaky`: la primera petición falla y la segunda pasada baja todo |
| El caso "el portal sólo baja el CDC consultado" | contra el servidor falso en modo `gate-cdc`: baja el habilitado, no inventa el resto y lo explica |
| Lector de *"Copy as cURL"* (bash y cmd) | autotest |
| Verificación de los XML (ítems, firma) | autotest con un DTE de ejemplo y con un archivo basura |
| Salida de errores clara | autotest: cuenta final, códigos de salida |

Para reproducirlo vos mismo, sin tocar el portal de la DNIT:

```bash
node tools/pruebas/auto.js
```

Resultado actual: **28 pruebas OK, 0 con problemas**.

### No probado todavía

| Qué | Riesgo real | Mitigación |
|---|---|---|
| **La extensión en un Chrome de verdad** | Nunca se ejecutó end-to-end (vos todavía no la usaste). Puede haber algún detalle de permisos, del diálogo de descarga o del badge | El camino importante (script) está probado; la extensión es un atajo, no un requisito |
| **Cookies `SameSite`** en el fetch de la extensión | La petición desde el service worker podría ir sin la cookie de sesión del portal | Plan B automático: repite el GET desde una pestaña del portal |
| **Descarga por `data:` URL** | Chrome podría rechazar ese tipo de descarga | Si falla, cae solo a descargar por URL |
| Un **CDC inexistente real** en el portal | No teníamos uno a mano para probar el "200 + HTML vacío" contra producción | El comportamiento está documentado y probado contra el servidor falso |

### Los límites de fondo (no son bugs, son del portal)

1. **Es un endpoint interno, sin contrato**: la DNIT puede cambiarlo o cerrarlo
   cuando quiera. Ya lo hizo al menos una vez (el 401 y el recorte por CDC).
2. **El WAF frena por ráfagas**: 401 que aparecen y se van solos. Mitigado con
   reintentos y la segunda pasada, no eliminado.
3. **Si el portal vuelve a exigir el captcha por comprobante**, la descarga en
   lote por web no es viable: cada CDC necesita su consulta en el navegador.
4. **La sesión vence**: cuando eso pasa, hay que repetir la captura del navegador
   (`--curl`) o consultar de nuevo.

### Veredicto

- **Para lo que fue hecha (bajar tus XML, pocos o algunos por mes): funciona.**
  Tenés los 4 comprobantes descargados y verificados, y el mes que viene son dos
  comandos.
- **Para automatizar en serio** (decenas o cientos por mes, sin intervención):
  **no**. Ahí el camino correcto es el **WS de SIFEN con certificado CCFE**
  (`consulta-de.wsdl`), que no depende de captchas, cookies ni de que el portal
  te habilite cada comprobante. La herramienta no promete eso.

---

## Cómo se usa el mes que viene

```cmd
REM 1) actualizar cdcs.txt con los CDC nuevos (uno por línea)
REM 2) descargar
node tools/descargar-xml.js --entrada cdcs.txt --salida ./xml

REM 3) verificar
node tools/resumen-xml.js xml
```

Si aparecen 401, correr otra vez el mismo comando (o con `--pausa 5000`). Los ya
descargados se vuelven a pedir sin problema: no hay que limpiar nada.
