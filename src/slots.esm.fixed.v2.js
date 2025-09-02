// slots.esm.js (corrigido e auto‑contido)
//
// Principais correções:
// - Dia da semana e formatações feitos sempre no TZ (ex.: America/Sao_Paulo).
// - Busca começa em `now + ADVANCE_MIN_HOURS` (sem "alinhar para 00:00").
// - Slots de 60 min fixos (SLOT_MINUTES) e nunca ultrapassam a janela do expediente (impede 15:30).
// - Implementação local de getBusyTimes() usando Google Calendar FreeBusy (remove import quebrado).
// - Conversão local→UTC estável para montar os instantes de cada faixa.

import { google } from "googleapis";

// ===== Variáveis de ambiente =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";
const TZ            = process.env.TZ || "America/Sao_Paulo";

// Expediente por dia (0=Dom, 1=Seg, ...)
let WORKING_HOURS = {};
try { WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}"); }
catch { WORKING_HOURS = {}; }

// Parâmetros de geração
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);  // 60 por padrão
const BUFFER_MIN   = Number(process.env.BUFFER_MINUTES || 0);
const ADVANCE_MIN  = Number(process.env.ADVANCE_MIN_HOURS || 1) * 60; // em minutos

// ===== Helpers de TZ/format =====
function formatDow(d)   { return new Intl.DateTimeFormat("pt-BR", { weekday:"short", timeZone: TZ }).format(d).replace(".", ""); }
function formatDate(d)  { return new Intl.DateTimeFormat("pt-BR", { day:"2-digit", month:"2-digit", year:"2-digit", timeZone: TZ }).format(d); }
function formatTime(d)  { return new Intl.DateTimeFormat("pt-BR", { hour:"2-digit", minute:"2-digit", timeZone: TZ }).format(d); }

// dia da semana (0..6) respeitando o TZ
function getDowTZ(d) {
  const key = formatDow(d).toLowerCase().slice(0,3);
  const map = { dom:0, seg:1, ter:2, qua:3, qui:4, sex:5, sab:6, sáb:6 };
  return map[key] ?? new Date(d).getUTCDay();
}

// Constrói um Date para o mesmo dia local de `base` às HH:MM locais.
// Implementação neutra (sem depender de DST do sistema receptor).
function buildLocalDate(base, hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const b = new Date(base);
  // Criar usando componentes locais do fuso do servidor alinhados pela data alvo:
  return new Date(b.getFullYear(), b.getMonth(), b.getDate(), h||0, m||0, 0, 0);
}

// Converte um "instante local" (Date criado via buildLocalDate) para ISO real (UTC).
function toISO(d) { return new Date(d).toISOString(); }

// ===== Google Auth =====
function getAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Faltam variáveis do Google (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN).");
  }
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

// ===== FreeBusy (dia inteiro) =====
async function getBusyTimes(auth, ids, day) {
  const cal = google.calendar({ version: "v3", auth });
  // Janela: 00:00 local → 00:00 do dia seguinte (em UTC via ISO real)
  const startLocal = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const endLocal   = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);

  const r = await cal.freebusy.query({
    requestBody: {
      timeMin: startLocal.toISOString(),
      timeMax: endLocal.toISOString(),
      items: ids.map(id => ({ id })),
    },
  });

  const cals = r?.data?.calendars || {};
  const out = [];
  for (const k of Object.keys(cals)) {
    const arr = cals[k]?.busy || [];
    for (const b of arr) {
      const s = new Date(b.start);
      const e = new Date(b.end);
      if (!isNaN(s) && !isNaN(e)) out.push({ start: s, end: e });
    }
  }
  return out;
}

// ===== Geração de slots =====
export async function listAvailableSlots({ fromISO, days = 7, limit = 100 } = {}) {
  // ponto de partida
  let from = fromISO ? new Date(fromISO) : new Date();
  if (ADVANCE_MIN > 0) from = new Date(from.getTime() + ADVANCE_MIN * 60000);

  const auth = getAuth();
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);

    const dow = getDowTZ(day);
    const ranges = WORKING_HOURS[String(dow)];
    if (!ranges || !ranges.length) continue;

    const busy = await getBusyTimes(auth, ids, day);
    const busyN = (busy || []).map(b => ({
      start: b.start instanceof Date ? b.start : new Date(b.start),
      end:   b.end   instanceof Date ? b.end   : new Date(b.end),
    }));

    for (const [hhIni, hhFim] of ranges) {
      let winStart = buildLocalDate(day, hhIni);
      let winEnd   = buildLocalDate(day, hhFim);

      if (BUFFER_MIN > 0) {
        winStart = new Date(winStart.getTime() + BUFFER_MIN * 60000);
        winEnd   = new Date(winEnd.getTime()   - BUFFER_MIN * 60000);
      }

      const startMs = winStart.getTime();
      const endMs   = winEnd.getTime();

      for (let t = startMs; t < endMs; t += SLOT_MINUTES * 60000) {
        const start = new Date(t);
        const end   = new Date(t + SLOT_MINUTES * 60000);

        if (end > winEnd) break;         // nunca 15:30–16:30
        if (start < from) continue;      // respeita antecedência mínima

        const overlap = busyN.some(b => !(end <= b.start || start >= b.end));
        if (overlap) continue;

        const dowShort = formatDow(start);
        const dayLabel = dowShort.charAt(0).toUpperCase() + dowShort.slice(1, 3);
        const label    = `${formatDate(start)} ${formatTime(start)}`;

        out.push({ startISO: toISO(start), endISO: toISO(end), dayLabel, label });
        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
