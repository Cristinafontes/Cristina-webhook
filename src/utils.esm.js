// utils.esm.js
/**
 * Parser de data/hora BR -> ISO UTC (dura 60min).
 * Exemplos aceitos: "30/08 às 14:00", "30/08 14h", "29/08 08:30".
 */
export function parseCandidateDateTime(text, _tz = "America/Sao_Paulo") {
  if (!text) return { found: false };
  const re = /(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)[^\d]{0,10}(\d{1,2})(?::?(\d{2}))?\s*(h|hs|horas|$)/i;
  const m = String(text).match(re);
  if (!m) return { found: false };

  const [dd, mm, yyyy] = (() => {
    const [d, m, y] = m[1].split("/");
    const year = y?.length === 4 ? Number(y) : (y ? 2000 + Number(y) : new Date().getFullYear());
    return [Number(d), Number(m), Number(year)];
  })();
  const HH = Number(m[2]);
  const MM = Number(m[3] || "0");

  if (!(dd>=1&&dd<=31) || !(mm>=1&&mm<=12) || !(HH>=0&&HH<=23) || !(MM>=0&&MM<=59)) return { found:false };

  // São Paulo UTC-3 -> para UTC: +3h
  const startUTC = new Date(Date.UTC(yyyy, mm-1, dd, HH+3, MM, 0, 0));
  const endUTC   = new Date(startUTC.getTime() + 60 * 60 * 1000);
  return {
    found: true,
    startISO: startUTC.toISOString(),
    endISO: endUTC.toISOString(),
    dd: String(dd).padStart(2,"0"),
    mm: String(mm).padStart(2,"0"),
    yy: String(yyyy % 100).padStart(2,"0"),
    hhmm: `${String(HH).padStart(2,"0")}:${String(MM).padStart(2,"0")}`
  };
}

// Intenção de cancelamento simples
export function isCancelIntent(text="") {
  const t = String(text||"").toLowerCase();
  return /(^|\b)(cancelar|desmarcar|remover|excluir|nao vou|não vou|quero cancelar|preciso cancelar|cancelamento)(\b|$)/.test(t);
}
