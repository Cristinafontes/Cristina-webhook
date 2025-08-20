import { google } from "googleapis";

/** ====== ENV ====== */
function env(a, b) { return process.env[a] || process.env[b] || ""; }
const CLIENT_ID     = env("GOOGLE_CLIENT_ID", "CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET", "CLIENT_SECRET");
const REDIRECT_URI  = env("GOOGLE_REDIRECT_URI", "REDIRECT_URI");
const REFRESH_TOKEN = env("GOOGLE_REFRESH_TOKEN", "REFRESH_TOKEN");
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ            = process.env.TZ || "America/Sao_Paulo";

/** ====== AUTH ====== */
function auth() {
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

/** ====== PARSER (auto-contido, NÃO usa utils.esm.js) ====== */
/** Normaliza PT-BR, remove palavras e vírgulas que atrapalham */
function normalizePtBrText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/hor[aá]rio/gi, "")
    .replace(/\bàs\b/gi, "")
    .replace(/,/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Converte hora 12h (am/pm) para 24h */
function to24h(hour12, ampm) {
  let h = Number(hour12);
  const s = (ampm || "").toLowerCase();
  if (s === "am") { if (h === 12) h = 0; }
  else if (s === "pm") { if (h !== 12) h += 12; }
  return h;
}

/** Gera ISO de início/fim assumindo offset América/São_Paulo (simplificado) */
function buildIsoRange(d, m, y, HH, MM) {
  let year = String(y || new Date().getFullYear());
  if (year.length === 2) year = "20" + year;
  const baseUTC = new Date(Date.UTC(Number(year), Number(m) - 1, Number(d), Number(HH), Number(MM || 0), 0));
  const offsetMinutes = /sao_paulo|são_paulo/i.test(TZ) ? 180 : 0;
  const startISO = new Date(baseUTC.getTime() + offsetMinutes * 60000).toISOString();
  const endISO   = new Date(new Date(startISO).getTime() + 60 * 60000).toISOString();
  return { startISO, endISO };
}

/**
 * Extrai data/hora de frases em PT-BR. Aceita:
 *  - dd/mm[/aa] HH:MM
 *  - dd/mm[/aa] HHh[MM]
 *  - dd/mm[/aa] H[H][[:]MM] ? am|pm  (ex.: "10am", "10 am", "10:30am", "10:00 am")
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

  // 3) dd/mm[/aa] H[H][[:]MM] ? am|pm  (aceita "10am", "10 am", "10:30am", "10:00 am")
  m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    const [, d, mo, y, h12, mm, ap] = m;
    const HH = to24h(h12, ap);
    return buildIsoRange(d, mo, y, HH, mm || "00");
  }

  // 4) dd/mm[/aa] H[H]am|pm  (sem espaço, ex.: "15/10 10am")
  m = norm.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})(am|pm)\b/i);
  if (m) {
    const [, d, mo, y, h12, ap] = m;
    const HH = to24h(h12, ap);
    return buildIsoRange(d, mo, y, HH, "00");
  }

  return null;
}

/** ====== CANCELAMENTO ====== */
/**
 * Cancela o primeiro evento encontrado na janela ±30min do horário extraído da frase.
 * Não exige a palavra "cancelada": qualquer frase com data/hora é considerada um pedido.
 */
export async function cancelEventFromMessage(message) {
  const parsed = parseBRDateTime(message);
  if (!parsed) {
    return { ok: false, cancelled: false, error: "Não consegui entender a data/horário na mensagem." };
  }

  try {
    const a = auth();
    const calendar = google.calendar({ version: "v3", auth: a });

    const center = new Date(parsed.startISO);
    const timeMin = new Date(center.getTime() - 30 * 60000).toISOString();
    const timeMax = new Date(center.getTime() + 30 * 60000).toISOString();

    const list = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax, singleEvents: true, orderBy: "startTime",
    });
    const items = list?.data?.items || [];
    if (!items.length) {
      return { ok: false, cancelled: false, error: "Nenhum evento encontrado para cancelar.", timeWindow: { timeMin, timeMax } };
    }

    const event = items[0];
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event.id, sendUpdates: "all" });
    return {
      ok: true,
      cancelled: true,
      cancelledEventSummary: event.summary,
      cancelledEventId: event.id,
      timeWindow: { timeMin, timeMax },
    };
  } catch (err) {
    return { ok: false, cancelled: false, error: String(err?.message || err) };
  }
}
