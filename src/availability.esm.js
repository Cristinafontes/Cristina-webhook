// availability.esm.js
// Verifica disponibilidade/bloqueio no Google Calendar antes de criar um evento.
// Usa freebusy.query em 1 ou 2 agendas: a agenda principal (GOOGLE_CALENDAR_ID)
// e, opcionalmente, uma agenda exclusiva de bloqueios (GOOGLE_BLOCK_CALENDAR_ID).
import { google } from "googleapis";

// ===== ENV =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";

// (opcional) definição de turnos para mensagens mais amigáveis
// Ex.: {"manha":["07:00","12:00"],"tarde":["12:00","18:00"],"noite":["18:00","22:00"]}
let TURNOS = {};
try { TURNOS = JSON.parse(process.env.TURNOS_JSON || "{}"); } catch { TURNOS = {}; }

function getAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Faltam variáveis do Google (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN).");
  }
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

function buildTime(dateISO, hhmm) {
  // retorna uma ISO no mesmo dia de dateISO com hora hh:mm
  const d = new Date(dateISO);
  const [hh, mm] = String(hhmm).split(":").map(Number);
  const local = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh + 3, mm || 0, 0)); // SP=UTC-3
  return local.toISOString();
}

/**
 * Retorna conflitos (busy) entre startISO/endISO.
 * Também lista os eventos conflitantes para mensagem ao usuário.
 */
export async function isSlotBlockedOrBusy({ startISO, endISO }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const items = [{ id: CALENDAR_ID }];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) items.push({ id: BLOCK_CAL_ID });

  const fb = await calendar.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, items },
  });

  const busy = Object.values(fb.data.calendars || {}).some((c) => (c.busy || []).length > 0);

  // Além do freebusy, listamos eventos para mostrar nomes dos conflitos
  const conflicts = [];
  for (const calId of items.map((i) => i.id)) {
    const { data } = await calendar.events.list({
      calendarId: calId,
      timeMin: startISO,
      timeMax: endISO,
      singleEvents: true,
      maxResults: 10,
      orderBy: "startTime",
    });
    for (const e of data.items || []) {
      conflicts.push({
        calendarId: calId,
        id: e.id,
        summary: e.summary || "(sem título)",
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date,
      });
    }
  }

  return { busy, conflicts };
}

/**
 * Facilita bloquear um turno criando um evento opaco (busy).
 * Ex.: await blockTurno({ dateISO: '2025-08-30T12:00:00Z', nomeTurno: 'manha' })
 */
export async function blockTurno({ dateISO, nomeTurno, titlePrefix = "[BLOQUEIO]" }) {
  if (!TURNOS[nomeTurno]) {
    throw new Error(`Turno '${nomeTurno}' não configurado. Defina TURNOS_JSON no .env`);
  }
  const [ini, fim] = TURNOS[nomeTurno]; // "07:00", "12:00"
  const startISO = buildTime(dateISO, ini);
  const endISO = buildTime(dateISO, fim);

  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const { data } = await calendar.events.insert({
    calendarId: BLOCK_CAL_ID || CALENDAR_ID,
    requestBody: {
      summary: `${titlePrefix} ${nomeTurno}`,
      description: "Janela indisponível criada pela Cristina",
      start: { dateTime: startISO, timeZone: "America/Sao_Paulo" },
      end: { dateTime: endISO, timeZone: "America/Sao_Paulo" },
      transparency: "opaque",
      visibility: "private",
    },
    sendUpdates: "none",
  });

  return data;
}
