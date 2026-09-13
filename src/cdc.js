/* Utilidades del CDC (Código de Control) — SIFEN / e-Kuatia, Paraguay.
 *
 * Composición según el Manual Técnico del SIFEN v150 (DNIT) §10.1:
 *   iTiDE(2) dRucEm(8) dDVEmi(1) dEst(3) dPunExp(3) dNumDoc(7)
 *   iTipCont(1) dFeEmiDE(8) iTipEmi(1) dCodSeg(9) dDVId(1)  = 44 dígitos
 *
 * Dígito verificador §10.2: módulo 11, pesos de 2 a 11 recorriendo la cadena
 * de derecha a izquierda; resto 10 u 11 se expresa como 0.
 *
 * Implementación de referencia consultada: sifen-cdc (MIT)
 * https://github.com/FindTek/sifen-cdc
 *
 * Este archivo se carga en tres contextos distintos: el service worker
 * (importScripts), la página de consulta (content script) y el popup.
 * No tiene dependencias y sólo declara funciones globales.
 */

var LARGO_CDC = 44;

/** Ancho de cada campo, en el orden en que aparece en el CDC. */
var LAYOUT_CDC = [
  ['tipoDocumento', 2],
  ['rucEmisor', 8],
  ['dvRucEmisor', 1],
  ['establecimiento', 3],
  ['puntoExpedicion', 3],
  ['numeroDocumento', 7],
  ['tipoContribuyente', 1],
  ['fechaEmision', 8],
  ['tipoEmision', 1],
  ['codigoSeguridad', 9],
];

var TIPO_DOCUMENTO = {
  1: 'Factura electrónica',
  2: 'Factura de exportación',
  3: 'Factura de importación',
  4: 'Autofactura electrónica',
  5: 'Nota de crédito electrónica',
  6: 'Nota de débito electrónica',
  7: 'Nota de remisión electrónica',
  8: 'Comprobante de retención electrónico',
};

/** Quita espacios, puntos y guiones: el KuDE imprime el CDC en grupos de 4. */
function normalizarCdc(texto) {
  return String(texto == null ? '' : texto).replace(/[\s.\-]/g, '');
}

/** Dígito verificador módulo 11 (Manual Técnico §10.2). */
function digitoVerificadorCdc(cadena, baseMax) {
  var base = baseMax || 11;
  if (!/^\d+$/.test(cadena)) {
    throw new Error('El dígito verificador sólo acepta dígitos');
  }
  var peso = 2;
  var suma = 0;
  for (var i = cadena.length - 1; i >= 0; i--) {
    if (peso > base) peso = 2;
    suma += Number(cadena.charAt(i)) * peso;
    peso++;
  }
  var resto = 11 - (suma % 11);
  return resto > 9 ? 0 : resto;
}

/**
 * Descompone un CDC y verifica su dígito verificador.
 * @throws {Error} si no son 44 dígitos.
 */
function analizarCdc(cdc) {
  var limpio = normalizarCdc(cdc);
  if (!/^\d{44}$/.test(limpio)) {
    throw new Error('El CDC debe tener 44 dígitos, se recibieron ' + limpio.length);
  }

  var campos = {};
  var pos = 0;
  for (var i = 0; i < LAYOUT_CDC.length; i++) {
    var nombre = LAYOUT_CDC[i][0];
    var ancho = LAYOUT_CDC[i][1];
    campos[nombre] = limpio.substr(pos, ancho);
    pos += ancho;
  }

  var esperado = digitoVerificadorCdc(limpio.slice(0, 43));
  var recibido = Number(limpio.charAt(43));

  return {
    cdc: limpio,
    tipoDocumento: Number(campos.tipoDocumento),
    tipoDocumentoNombre: TIPO_DOCUMENTO[Number(campos.tipoDocumento)] || 'Desconocido',
    rucEmisor: campos.rucEmisor,
    dvRucEmisor: campos.dvRucEmisor,
    establecimiento: campos.establecimiento,
    puntoExpedicion: campos.puntoExpedicion,
    numeroDocumento: campos.numeroDocumento,
    tipoContribuyente: campos.tipoContribuyente,
    fechaEmision: campos.fechaEmision,
    tipoEmision: campos.tipoEmision,
    codigoSeguridad: campos.codigoSeguridad,
    valido: esperado === recibido,
    digitoVerificadorRecibido: recibido,
    digitoVerificadorEsperado: esperado,
  };
}

/** Dígito verificador del RUC: mismo módulo 11, anclado a la derecha. */
function digitoVerificadorRuc(ruc) {
  return digitoVerificadorCdc(String(ruc).replace(/\D/g, '').padStart(8, '0'));
}

/** ¿Es un CDC bien formado y con el dígito verificador correcto? Nunca lanza. */
function validarCdc(cdc) {
  try {
    return analizarCdc(cdc).valido;
  } catch (e) {
    return false;
  }
}

/** Extrae el primer CDC de 44 dígitos que aparezca en un texto libre. */
function extraerCdc(texto) {
  var limpio = normalizarCdc(texto);
  var match = limpio.match(/\d{44}/);
  return match ? match[0] : null;
}

/** CDC en grupos de cuatro, como se imprime en el KuDE. */
function formatearCdc(cdc) {
  var limpio = normalizarCdc(cdc);
  return (limpio.match(/.{1,4}/g) || []).join(' ');
}

/** 'AAAAMMDD' -> Date (o null si la fecha es imposible). */
function fechaDeCdc(aaaammdd) {
  var d = new Date(
    Date.UTC(
      Number(aaaammdd.slice(0, 4)),
      Number(aaaammdd.slice(4, 6)) - 1,
      Number(aaaammdd.slice(6, 8))
    )
  );
  return isNaN(d.getTime()) ? null : d;
}

/* El archivo se usa en tres contextos (service worker por importScripts,
 * content script y popup) y también desde Node con el CLI de tools/.
 * En navegador `module` no existe y este bloque se ignora.
 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LARGO_CDC: LARGO_CDC,
    LAYOUT_CDC: LAYOUT_CDC,
    TIPO_DOCUMENTO: TIPO_DOCUMENTO,
    normalizarCdc: normalizarCdc,
    digitoVerificadorCdc: digitoVerificadorCdc,
    digitoVerificadorRuc: digitoVerificadorRuc,
    analizarCdc: analizarCdc,
    validarCdc: validarCdc,
    extraerCdc: extraerCdc,
    formatearCdc: formatearCdc,
    fechaDeCdc: fechaDeCdc,
  };
}
