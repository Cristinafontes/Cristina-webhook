// utils.esm.js
import { parse } from "date-fns";
import { zonedTimeToUtc } from "date-fns-tz";

/**
 * Lê datas no formato brasileiro em mensagens do WhatsApp e retorna startISO/endISO.
 * Ex.: "30/08 às 14:00", "30/08 14h", "29/08 08:30"
 * Duração padrão: 60 minutos.
 */
export function parseCandidateDateTime(text, tz = "America/Sao_Paulo") {
  const re = /(\b\d{1,2}\/\d{1,2}\b)[^\d]{0,10}(\d{1,2})(?::?(\d{2}))?\s*(h|hs|horas|)$/i;
  const m = (text || "").match(re);
  if (!m) return { found: false };

  const dayMonth = m[1];
  const hourStr = m[2];
  const minStr = m[3] || "00";

  const now = new Date();
  const composed = `${dayMonth}/${now.getFullYear()} ${hourStr}:${minStr}`;

  try {
    const local = parse(composed, "d/M/yyyy HH:mm", new Date());
    const startUTC = zonedTimeToUtc(local, tz);
    const endUTC = new Date(startUTC.getTime() + 60 * 60 * 1000);
    return { found: true, startISO: startUTC.toISOString(), endISO: endUTC.toISOString() };
  } catch {
    return { found: false };
  }
}
