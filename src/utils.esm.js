
// src/utils.esm.js

/**
 * Normaliza um texto em PT-BR removendo palavras que atrapalham a leitura
 * de data/hora (“horário”, “às”, vírgulas, etc.).
 */
export function normalizePtBrText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/hor[aá]rio/gi, "")   // remove "horario"/"horário"
    .replace(/\bàs\b/gi, "")       // remove "às"
    .replace(/,/g, " ")            // vírgulas -> espaço
    .replace(/\s{2,}/g, " ")       // espaços extras
    .trim();
}

/**
 * Converte hora 12h (am/pm) para 24h.
 * 12am -> 00h ; 12pm -> 12h
 */
function to24h(hour12, ampm) {
  let h = Number(hour12);
  const suffix = (ampm || "").toLowerCase();
  if (suffix === "am") {
    if (h === 12) h = 0;
  } else if (suffix === "pm") {
    if (h !== 12) h += 12;
  }
  return h;
}

/**
 * Constrói inicio/fim ISO considerando TZ (default America/Sao_Paulo).
 * Para simplificar, usa offset fixo de -03:00.
 */
function buildIsoRange(d, m, y, HH, MM) {
  // Ajusta ano de 2 dígitos
  let year = String(y || new Date().getFullYear());
  if (year.length === 2) year = "20" + year;

  // data/hora base em UTC, depois aplica offset de São Paulo (-03:00)
  const baseUTC = new Date(Date.UTC(Number(year), Number(m) - 1, Number(d), Number(HH), Number(MM || 0), 0));
  const offsetMinutes = 180; // +03:00 em minutos (ajuste simples)
  const startISO = new Date(baseUTC.getTime() + offsetMinutes * 60000).toISOString();
  const endISO   = new Date(new Date(startISO).getTime() + 60 * 60000).toISOString(); // 60min
  return { startISO, endISO };
}

/**
 * Parser principal: tenta extrair data dd/mm[/aa|aaaa] e horário (vários formatos).
 * Formatos aceitos:
 *  - dd/mm[/aa] HH:MM
 *  - dd/mm[/aa] HHh[MM]
 *  - dd/mm[/aa] H[H]am | H[H]:MMam | H[H] pm | H[H]:MM pm | H[H]:MM am|pm
 *
 * Retorna { startISO, endISO } ou null.
 */
export function parseBRDateTime(text) {
  const norm = normalizePtBrText(text);

  // 1) dd/mm[/aa] HH:MM
  let m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2}):(\d{2})\b/i);
  if (m) {
    const [, d, mo, y, HH, MM] = m;
    return buildIsoRange(d, mo, y, HH, MM);
  }

  // 2) dd/mm[/aa] HHh[MM]
  m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})h(?:(\d{2}))?\b/i);
  if (m) {
    const [, d, mo, y, Hh, mm] = m;
    return buildIsoRange(d, mo, y, Hh, mm || "00");
  }

  // 3) dd/mm[/aa] H[H][[:]MM] ? am|pm (aceita "10am", "10 am", "10:30am", "10:30 pm", "10:00 am")
  m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    const [, d, mo, y, h12, mm, ap] = m;
    const HH = to24h(h12, ap);
    return buildIsoRange(d, mo, y, HH, mm || "00");
  }

  // 4) dd/mm[/aa] H[H]am|pm sem espaço (ex.: "15/10 10am")
  m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})(am|pm)\b/i);
  if (m) {
    const [, d, mo, y, h12, ap] = m;
    const HH = to24h(h12, ap);
    return buildIsoRange(d, mo, y, HH, "00");
  }

  return null;
}
