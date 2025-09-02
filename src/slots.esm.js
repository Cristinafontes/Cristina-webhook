// slots.esm.js
// Lista horários disponíveis checando o freebusy do Google Calendar e uma agenda opcional de bloqueios.
// Gera janelas de X minutos dentro do expediente configurado.
import { google } from "googleapis";

// ===== ENV =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";
const TZ            = process.env.TZ || "America/Sao_Paulo";

// === Helpers de fuso horário ===
// Sempre que formos formatar ou montar rótulos, usamos o TZ explicitamente.
function toTZ(d) {
  // garante que temos um Date; o fuso é aplicado na FORMATAÇÃO (Intl) mais adiante
  return d instanceof Date ? d : new Date(d);
}
function startOfDayLocal(d) {
  const x = toTZ(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0);
}
// Formatações com TZ (vamos usar no passo 2.2)
function formatDow(d) {
  return toTZ(d).toLocaleDateString("pt-BR", { weekday: "short", timeZone: TZ });
}
function formatDate(d) {
  return toTZ(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: TZ });
}
function formatTime(d) {
  return toTZ(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

// expediente por dia da semana (0=Dom,1=Seg,...)
// exemplo: {"1":[["08:00","12:00"],["13:30","17:30"]],"2":[["08:00","12:00"],["13:30","17:30"]], ...}
let WORKING_HOURS = {};
try { WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}"); } catch { WORKING_HOURS = {}; }

const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 30);
const BUFFER_MIN   = Number(process.env.BUFFER_MINUTES || 0);  // minutos a mais antes/depois
const ADVANCE_MIN  = Number(process.env.ADVANCE_MIN_HOURS || 1) * 60; // não ofertar slots muito em cima da hora

function getAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Faltam variáveis do Google (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN).");
  }
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

function toLocal(date) {
  // para SP sem DST (simples): subtrai 3h do UTC para exibir
  const d = new Date(date);
  const local = new Date(d.getTime() - 3*60*60*1000);
  return local;
}
function pad(n){ return String(n).padStart(2,"0"); }
function fmtHour(date) {
  const d = toLocal(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isoAt(date, hhmm) {
  const d = new Date(date);
  const [hh, mm] = String(hhmm).split(":").map(Number);
  const z = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh + 3, mm || 0, 0)); // SP=UTC-3
  return z.toISOString();
}

function* iterateSlots(dayISO, ranges) {
  for (const [ini, fim] of ranges) {
    let start = new Date(isoAt(dayISO, ini));
    const end   = new Date(isoAt(dayISO, fim));
    // aplicar buffers
    start = new Date(start.getTime() + BUFFER_MIN * 60 * 1000);
    const endAdj = new Date(end.getTime() - BUFFER_MIN * 60 * 1000);

    while (new Date(start.getTime() + SLOT_MINUTES*60000) <= endAdj) {
      const sISO = start.toISOString();
      const eISO = new Date(start.getTime() + SLOT_MINUTES*60000).toISOString();
      yield [sISO, eISO];
      start = new Date(start.getTime() + SLOT_MINUTES*60000);
    }
  }
}

async function freebusy(auth, timeMin, timeMax, ids) {
  const calendar = google.calendar({ version: "v3", auth });
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin, timeMax,
      items: ids.map(id => ({ id })),
    },
  });
  const busyMap = fb.data.calendars || {};
  const busy = [];
  for (const calId of ids) {
    for (const b of (busyMap[calId]?.busy || [])) busy.push({ ...b, calId });
  }
  return busy;
}

/**
 * Lista até N slots livres a partir de uma data (inclusive), olhando D dias pela frente.
 * @param {Object} params
 * @param {string} params.fromISO    ISO início da busca (padrão agora)
 * @param {number} params.days       Quantos dias olhar adiante (padrão 7)
 * @param {number} params.limit      Máximo de slots a retornar (padrão 10)
 * @returns Array<{startISO,endISO,label,dayLabel}>
 */

export async function listAvailableSlots({ fromISO, days = 7, limit = 100 } = {}) {
  let from = fromISO ? new Date(fromISO) : new Date();

  // respeitar antecedência mínima (em horas)
  const advMin = Number(process.env.ADVANCE_MIN_HOURS || 1);
  if (advMin > 0) {
    from = new Date(from.getTime() + advMin * 60 * 60 * 1000);
  }

  // Não alinhar para início do dia aqui


  const auth = getAuth();
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  // varrer por dia
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);

    // usar getDay() no fuso local (0=Dom, 1=Seg...)
    const dow = toTZ(day).getDay();
    const ranges = WORKING_HOURS[String(dow)];
    if (!ranges || !ranges.length) continue;

    // pegar busy slots do Google
    const busy = await getBusyTimes(auth, ids, day);

const busyN = (busy || []).map(b => ({
  start: b.start instanceof Date ? b.start : new Date(b.start),
  end:   b.end   instanceof Date ? b.end   : new Date(b.end),
}));

function buildDate(d, hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0, 0, 0);
}

const stepMin = Number(process.env.SLOT_MINUTES || 60);
const durMin  = stepMin;
const cutoff  = new Date(Date.now() + Number(process.env.ADVANCE_MIN_HOURS || 1) * 60 * 60 * 1000);

for (const [hhIni, hhFim] of ranges) {
  let winStart = buildDate(day, hhIni);
  let winEnd   = buildDate(day, hhFim);

  const buf = Number(process.env.BUFFER_MINUTES || 0);
  if (buf > 0) {
    winStart = new Date(winStart.getTime() + buf * 60000);
    winEnd   = new Date(winEnd.getTime()   - buf * 60000);
  }

  const startMs = winStart.getTime();
  const endMs   = winEnd.getTime();

  for (let t = startMs; t + durMin*60000 <= endMs; t += stepMin*60000) {
  const start = new Date(t);
  const end   = new Date(t + durMin*60000);

  // última consulta deve terminar até endMs
  if (end > endMs) break;

    if (start < cutoff) continue;

    const overlap = busyN.some(b => !(end <= b.start || start >= b.end));
    if (overlap) continue;

    const dowShort = formatDow(start).replace(".", "");
    const dayLabel = dowShort.charAt(0).toUpperCase() + dowShort.slice(1, 3);
    const label    = `${formatDate(start)} ${formatTime(start)}`;

    out.push({
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      dayLabel,
      label,
    });

       if (out.length >= limit) return out;
  } 
}   
}   
return out;
}   
