// src/gcal.esm.js
export function normalizePtBrText(text) {
  if (!text) return "";
  return text
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/às/gi, " ") // corrige "às" -> " "
    .replace(/horario/gi, "")
    .replace(/horário/gi, "")
    .replace(/,/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
