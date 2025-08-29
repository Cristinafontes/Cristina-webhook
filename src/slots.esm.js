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
  const now = new Date();
  const from = fromISO ? new Date(fromISO) : now;

  const auth = getAuth();
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  // varrer por dia
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() + i, 0, 0, 0
    ));

    // usar getDay() no fuso local (0=Dom, 1=Seg...)
    const dow = (new Date(day)).getDay();
    const ranges = WORKING_HOURS[String(dow)];
    if (!ranges || !ranges.length) continue;

    // pegar busy slots do Google
    const busy = await getBusyTimes(auth, ids, day);

    // percorrer todos os ranges do expediente
    for (const range of ranges) {
      const dayStart = isoAt(day.toISOString(), range[0]);
      const dayEnd   = isoAt(day.toISOString(), range[1]);

      // gerar slots dentro do range
      for (let t = new Date(dayStart); t < new Date(dayEnd); t.setMinutes(t.getMinutes() + SLOT_MINUTES)) {
        const sISO = new Date(t).toISOString();
        const eISO = new Date(t.getTime() + SLOT_MINUTES * 60000).toISOString();

        // pular se estiver muito em cima da hora
        if (new Date(sISO) < new Date(now.getTime() + ADVANCE_MIN * 60000)) continue;

        // se houver interseção com qualquer busy, descarta
        const overlap = busy.some(b =>
          !(new Date(eISO) <= new Date(b.start) || new Date(sISO) >= new Date(b.end))
        );
        if (overlap) continue;

        const weekday = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"][dow];
        out.push({
          startISO: sISO,
          endISO: eISO,
          label: `${fmtHour(sISO)}-${fmtHour(eISO)}`,
          dayLabel: `${weekday} ${pad(toLocal(sISO).getDate())}/${pad(toLocal(sISO).getMonth()+1)}`,
        });

        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
