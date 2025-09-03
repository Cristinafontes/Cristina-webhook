// slots.esm.js (corrigido com fuso fixo)
// - Usa TZ_OFFSET_HOURS (padrão -3 / São Paulo) para construir instantes no fuso desejado.
// - Garante slots de 60 minutos e não permite extrapolar a faixa (adeus 15:30).
// - Começa a busca em now + ADVANCE_MIN_HOURS (sem reset para 00:00).
// - Labels e dia-da-semana formatados em TZ (America/Sao_Paulo).
// - Implementa getBusyTimes local via FreeBusy.

import { google } from "googleapis";

// ===== Vars =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";

const TZ             = process.env.TZ || "America/Sao_Paulo";
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? -3); // <- ajuste fino, padrão -3 (BR sem DST)

let WORKING_HOURS = {};
try { WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}"); } catch { WORKING_HOURS = {}; }

const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);
const BUFFER_MIN   = Number(process.env.BUFFER_MINUTES || 0);
const ADVANCE_MIN  = Number(process.env.ADVANCE_MIN_HOURS || 1) * 60; // em minutos

// ===== Helpers =====
const TZ = process.env.TZ || "America/Sao_Paulo";

function fmtWeekday(d) {
  // "seg.", "ter.", ... -> "Seg", "Ter", ...
  const raw = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: TZ }).format(d);
  const clean = raw.replace(".", "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
function fmtDate(d) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: TZ }).format(d);
}
function fmtTime(d) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(d);
}
// 0=Dom..6=Sáb calculado de forma robusta
function getDowTZ(d) {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d).toLowerCase();
  return ["sun","mon","tue","wed","thu","fri","sat"].indexOf(wd);
}

// Constrói um Date (UTC) correspondente ao horário local em TZ_OFFSET_HOURS do mesmo dia de `base`.
function atTZ(base, hhmm) {
  const [h,m] = String(hhmm).split(":").map(Number);
  const b = new Date(base);
  // local -> UTC: somar o offset para obter o mesmo instante UTC
  const utc = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), (h ?? 0) - TZ_OFFSET_HOURS, m ?? 0, 0, 0);
  return new Date(utc);
}

// Auth
function getAuth(){
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Google OAuth: variáveis ausentes.");
  }
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

// FreeBusy para um dia (00:00..24:00 em TZ_OFFSET_HOURS)
async function getBusyTimes(auth, ids, day){
  const cal = google.calendar({ version:"v3", auth });
  const start = atTZ(day, "00:00");
  const end   = atTZ(new Date(day.getTime() + 24*60*60*1000), "00:00");
  const r = await cal.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: ids.map(id => ({ id })),
    },
  });
  const out = [];
  const cals = r?.data?.calendars || {};
  for (const k of Object.keys(cals)) {
    for (const b of (cals[k]?.busy || [])) {
      const s = new Date(b.start);
      const e = new Date(b.end);
      if (!isNaN(s) && !isNaN(e)) out.push({ start:s, end:e });
    }
  }
  return out;
}

// ===== Geração =====
export async function listAvailableSlots({ fromISO, days=7, limit=100 } = {}){
  let from = fromISO ? new Date(fromISO) : new Date();
  if (ADVANCE_MIN > 0) from = new Date(from.getTime() + ADVANCE_MIN*60000);

  const auth = getAuth();
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  for (let i=0; i<days; i++){
    const day = new Date(from.getTime() + i*24*60*60*1000);

    const dow = getDowTZ(day);
    const ranges = WORKING_HOURS[String(dow)];
    if (!ranges || !ranges.length) continue;

    const busy = await getBusyTimes(auth, ids, day);
    const busyN = busy.map(b => ({
      start: b.start instanceof Date ? b.start : new Date(b.start),
      end:   b.end   instanceof Date ? b.end   : new Date(b.end),
    }));

    for (const [hIni, hFim] of ranges){
      let winStart = atTZ(day, hIni);
      let winEnd   = atTZ(day, hFim);

      if (BUFFER_MIN > 0){
        winStart = new Date(winStart.getTime() + BUFFER_MIN*60000);
        winEnd   = new Date(winEnd.getTime()   - BUFFER_MIN*60000);
      }

      const startMs = winStart.getTime();
      const endMs   = winEnd.getTime();

      for (let t=startMs; t<endMs; t += SLOT_MINUTES*60000){
        const start = new Date(t);
        const end   = new Date(t + SLOT_MINUTES*60000);

        if (end > winEnd) break;     // última não ultrapassa a faixa
        if (start < from) continue;   // respeita antecedência

        const overlap = busyN.some(b => !(end <= b.start || start >= b.end));
        if (overlap) continue;

        // Gera rótulos SEMPRE a partir do MESMO Date e MESMO TZ
const dayLabel = fmtWeekday(start);                     // "Seg", "Ter", ...
const label    = `${fmtDate(start)} ${fmtTime(start)}`; // "18/09/25 09:00"

out.push({
  startISO: start.toISOString(),
  endISO:   end.toISOString(),
  dayLabel,
  label,
});

        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
