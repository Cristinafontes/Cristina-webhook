// utils.esm.js
/**
 * Lê datas no formato brasileiro em mensagens de WhatsApp e retorna startISO/endISO.
 * Aceita: "30/08 às 14:00", "30/08 14h", "29/08 08:30", e variações.
 * Duração padrão: 60 minutos.
 *
 * Obs.: convertemos para UTC assumindo fuso de São Paulo (UTC-3, sem horário de verão).
 */
export function parseCandidateDateTime(text, _tz = "America/Sao_Paulo") {
  if (!text) return { found: false };

  // Padrões aceitos: dd/mm HH:mm | dd/mm HHh
  const re = /(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)[^\d]{0,10}(\d{1,2})(?::?(\d{2}))?\s*(h|hs|horas|$)/i;
  const m = String(text).match(re);
  if (!m) return { found: false };

  const dayMonthYear = m[1]; // dd/mm[/aa|aaaa]
  const hourStr = m[2];      // HH
  const minStr = m[3] || "00";

  // Se não vier ano no texto, usamos o ano corrente
  const now = new Date();
  let dd, mm, yyyy;
  const parts = dayMonthYear.split("/").map(s => s.trim());
  dd = parseInt(parts[0], 10);
  mm = parseInt(parts[1], 10);
  if (parts.length >= 3) {
    // ano 2 ou 4 dígitos
    let y = parts[2];
    if (y.length === 2) {
      // converte "25" -> 2025
      const base = 2000;
      yyyy = base + parseInt(y, 10);
    } else {
      yyyy = parseInt(y, 10);
    }
  } else {
    yyyy = now.getFullYear();
  }

  const HH = parseInt(hourStr, 10);
  const MM = parseInt(minStr, 10);

  if (
    !(dd >= 1 && dd <= 31) ||
    !(mm >= 1 && mm <= 12) ||
    !(HH >= 0 && HH <= 23) ||
    !(MM >= 0 && MM <= 59)
  ) {
    return { found: false };
  }

  // São Paulo = UTC-3. Para obter o instante UTC correspondente ao horário local,
  // somamos +3 horas no construtor UTC.
  // Ex.: 14:00 em São Paulo == 17:00 UTC.
  const startUTC = new Date(Date.UTC(yyyy, mm - 1, dd, HH + 3, MM, 0, 0));
  const endUTC = new Date(startUTC.getTime() + 60 * 60 * 1000); // +60 min

  return { found: true, startISO: startUTC.toISOString(), endISO: endUTC.toISOString() };
}


// Detecta intenção de cancelamento
export function isCancelIntent(text = "") {
  const t = String(text||"").toLowerCase();
  return /(^|\b)(cancelar|desmarcar|remover|excluir|nao vou|não vou|quero cancelar|preciso cancelar|cancelamento)(\b|$)/.test(t);
}
