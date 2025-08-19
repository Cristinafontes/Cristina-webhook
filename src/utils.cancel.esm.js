// utils.cancel.esm.js
import { parseCandidateDateTime } from "./utils.esm.js";

/**
 * Faz o parsing de mensagens de cancelamento no formato:
 * - "16/08/25, horário 10:00"
 * - "16/08/2025, horario 10:00"
 * - "16/08/25 às 10:00"
 * - "16/08/25 10:00"
 */
export function parseCancelDateTime(text, tz = "America/Sao_Paulo") {
  if (!text) return { found: false };

  // Normaliza
  const norm = text
    .toLowerCase()
    .replace("horário", "")
    .replace("horario", "")
    .replace("às", "")
    .replace(",", " ");

  return parseCandidateDateTime(norm, tz);
}
