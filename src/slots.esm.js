// slots.esm.js (com agrupamento por dia e formatação de texto)
// - Mantém listAvailableSlots (compatível com o que já funciona).
// - Adiciona helpers para: agrupar por dia, achar "dia ou próximo", e formatar texto no layout pedido.

import { google } from "googleapis";

// ===== Vars =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";

const TZ              = process.env.TZ || "America/Sao_Paulo";
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? -3); // padrão -3 (SP sem DST)

let WORKING_HOURS = {};
try { WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}"); } catch { WORKING_HOURS = {}; }

const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);
const BUFFER_MIN   = Number(process.env.BUFFER_MINUTES || 0);
const ADVANCE_MIN  = Number(process.env.ADVANCE_MIN_HOURS || 1) * 60; // em minutos

// ===== Helpers de data/hora =====
const WEEKDAY_FULL = new Intl.DateTimeFormat("pt-BR", { weekday:"long", timeZone: TZ });
const DATE_DDMMYY  = new Intl.DateTimeFormat("pt-BR", { day:"2-digit", month:"2-digit", year:"2-digit", timeZone: TZ });
const TIME_HHMM    = new Intl.DateTimeFormat("pt-BR", { hour:"2-digit", minute:"2-digit", timeZone: TZ });

function fmtDow(d){ return new Intl.DateTimeFormat("pt-BR",{weekday:"short", timeZone: TZ}).format(d).replace(".",""); }
function fmtDate(d){ return DATE_DDMMYY.format(d); }
function fmtTime(d){ return TIME_HHMM.format(d); }
function getDowTZ(d){
  const k=fmtDow(d).toLowerCase().slice(0,3);
  const map={dom:0,seg:1,ter:2,qua:3,qui:4,sex:5,sab:6,"sáb":6};
  return map[k] ?? new Date(d).getUTCDay();
}
function cap(str){
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Constrói um Date (UTC) correspondente ao horário local em TZ_OFFSET_HOURS do mesmo dia de `base`.
function atTZ(base, hhmm) {
  const [h,m] = String(hhmm).split(":").map(Number);
  const b = new Date(base);
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

// ===== Núcleo: mesma função de sempre (compatível) =====
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

        if (end > winEnd) break;      // última não ultrapassa a faixa
        if (start < from) continue;   // respeita antecedência

        const overlap = busyN.some(b => !(end <= b.start || start >= b.end));
        if (overlap) continue;

        // Mantém os campos esperados pelo server atual
        const dowShort = fmtDow(start);                    // ex.: "qua."
        const dayLabel = cap(dowShort.replace(".","").slice(0,3)); // "Qua"
        const label    = `${fmtDate(start)} ${fmtTime(start)}`;    // "03/09/25 08:00"

        out.push({ startISO: start.toISOString(), endISO: end.toISOString(), dayLabel, label });

        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}

// ===== Novidades (não quebram nada): agrupamento e formatação =====

// Agrupa um array de slots (do listAvailableSlots) por data dd/mm/aa
export function groupSlotsByDay(slots){
  const groups = [];
  const byKey = new Map();

  for (const s of slots || []){
    const dateKey = (s.label || "").slice(0,8); // "dd/mm/aa"
    const when = new Date(s.startISO);
    const wd = WEEKDAY_FULL.format(when);       // "quarta-feira"
    const dateLabel = fmtDate(when);            // "03/09/25"
    const time = fmtTime(when);                 // "08:00"

    if (!byKey.has(dateKey)){
      byKey.set(dateKey, { dateKey, weekday: wd, dateLabel, times: [] });
      groups.push(byKey.get(dateKey));
    }
    byKey.get(dateKey).times.push(time);
  }
  // Ordena horários dentro de cada dia
  for (const g of groups){
    g.times = Array.from(new Set(g.times)).sort((a,b)=>a.localeCompare(b));
  }
  return groups;
}

// Lista já "pronto por dia" a partir de uma data (fromISO), por N dias
export async function listAvailableSlotsByDay({ fromISO, days=7, limitPerDay=20 } = {}){
  const flat = await listAvailableSlots({ fromISO, days, limit: days * limitPerDay });
  const grouped = groupSlotsByDay(flat);
  // corta por limite por dia
  for (const g of grouped){
    if (g.times.length > limitPerDay) g.times = g.times.slice(0, limitPerDay);
  }
  return grouped;
}

// Tenta o DIA alvo; se vazio, acha a PRÓXIMA DATA que tenha horários (até searchDays)
export async function findDayOrNextWithSlots({ targetISO, searchDays=14, limitPerDay=20 } = {}){
  if (!targetISO) {
    // se não veio alvo, retorna os próximos dias agrupados
    return { status:"from-now", groups: await listAvailableSlotsByDay({ fromISO: new Date().toISOString(), days: 7, limitPerDay }) };
  }

  const dayStart = new Date(targetISO);
  // Normaliza para 00:00 local (TZ_OFFSET) -> UTC
  const startUTC = atTZ(dayStart, "00:00").toISOString();

  // 1) Só o dia solicitado
  const gToday = await listAvailableSlotsByDay({ fromISO: startUTC, days: 1, limitPerDay });
  if (gToday.length && gToday[0]?.times?.length) {
    return { status:"exact-day", groups: gToday };
  }

  // 2) Procura a próxima data com horários (até searchDays)
  const gForward = await listAvailableSlotsByDay({ fromISO: startUTC, days: searchDays, limitPerDay });
  if (gForward.length) {
    // pega só o primeiro dia que tem horários
    const first = gForward[0];
    return { status:"next-day", groups: [first] };
  }

  return { status:"none", groups: [] };
}

// Texto no layout pedido
export function formatSlotsForPatient(groups){
  if (!groups || !groups.length) {
    return "No momento não encontrei janelas livres próximas dessa data.";
  }
  const lines = [];
  lines.push("Claro, seguem as opções de agendamento:");
  for (const g of groups){
    const weekday = cap(String(g.weekday || "").replace(/^\s+|\s+$/g, "")); // ex.: "Quarta-feira"
    lines.push(`${weekday} ${g.dateLabel}:`);
    for (const t of g.times){
      lines.push(`  ${t}`);
    }
    lines.push(""); // linha em branco entre dias
  }
  lines.push("Escolha a opção que desejar!");
  return lines.join("\n");
}
export function rankSlotsByProximity(items, targetISO) {
  if (!targetISO || !Array.isArray(items)) return items || [];
  const t = new Date(targetISO).getTime();
  return [...items].sort((a, b) => {
    const da = Math.abs(new Date(a.startISO).getTime() - t);
    const db = Math.abs(new Date(b.startISO).getTime() - t);
    return da - db;
  });
}
