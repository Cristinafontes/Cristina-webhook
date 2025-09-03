
// ==============================
// slots.esm.js - Corrigido
// ==============================

import { google } from "googleapis";

// Variáveis de ambiente
const TZ = process.env.TZ || "America/Sao_Paulo";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);
const BUFFER_MINUTES = Number(process.env.BUFFER_MINUTES || 0);
const ADVANCE_MIN_HOURS = Number(process.env.ADVANCE_MIN_HOURS || 1);

// Working hours JSON: exemplo {"1":[["08:00","12:00"],["13:00","16:00"]], "2":[["08:00","12:00"],["13:00","16:00"]], "5":[["08:00","12:00"]]}
let WORKING_HOURS = {};
try {
  WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}");
} catch {
  WORKING_HOURS = {};
}

// Helpers de formatação
function fmtDate(d) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: TZ,
  }).format(d);
}

function fmtTime(d) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  }).format(d);
}

function fmtWeekday(d) {
  const raw = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    timeZone: TZ,
  }).format(d);
  const clean = raw.replace(".", "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// Constrói Date no TZ
function buildDate(day, hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    h || 0,
    m || 0,
    0,
    0
  );
}

// Consulta busy times no Google Calendar
async function getBusyTimes(auth, ids, day) {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);

  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: TZ,
      items: ids.map((id) => ({ id })),
    },
  });

  return (res.data.calendars[CALENDAR_ID]?.busy || []).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

// Função principal
export async function listAvailableSlots({ fromISO, days = 7, limit = 100 } = {}) {
  const { auth } = await import("./google.esm.js");
  const client = await auth();

  let from = fromISO ? new Date(fromISO) : new Date();
  const cutoff = new Date(Date.now() + ADVANCE_MIN_HOURS * 60 * 60 * 1000);
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const dow = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: TZ,
    }).format(day);

    const ranges = WORKING_HOURS[String(day.getDay())];
    if (!ranges || !ranges.length) continue;

    const busy = await getBusyTimes(client, ids, day);

    for (const [hhIni, hhFim] of ranges) {
      let winStart = buildDate(day, hhIni);
      let winEnd = buildDate(day, hhFim);

      if (BUFFER_MINUTES > 0) {
        winStart = new Date(winStart.getTime() + BUFFER_MINUTES * 60000);
        winEnd = new Date(winEnd.getTime() - BUFFER_MINUTES * 60000);
      }

      const startMs = winStart.getTime();
      const endMs = winEnd.getTime();

      for (let t = startMs; t < endMs; t += SLOT_MINUTES * 60000) {
        const start = new Date(t);
        const end = new Date(t + SLOT_MINUTES * 60000);

        if (end > endMs) break;
        if (start < cutoff) continue;

        const overlap = busy.some(
          (b) => !(end <= b.start || start >= b.end)
        );
        if (overlap) continue;

        out.push({
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          dayLabel: fmtWeekday(start),
          label: `${fmtDate(start)} ${fmtTime(start)}`,
        });

        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
