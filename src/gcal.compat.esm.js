import { google } from "googleapis";

/**
 * Reads env vars in a backwards-compatible way.
 * Accepts both:
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI / GOOGLE_REFRESH_TOKEN
 *   - CLIENT_ID / CLIENT_SECRET / REDIRECT_URI / REFRESH_TOKEN
 */
function readEnv(nameA, nameB) {
  return process.env[nameA] || process.env[nameB] || "";
}

const CLIENT_ID = readEnv("GOOGLE_CLIENT_ID", "CLIENT_ID");
const CLIENT_SECRET = readEnv("GOOGLE_CLIENT_SECRET", "CLIENT_SECRET");
const REDIRECT_URI = readEnv("GOOGLE_REDIRECT_URI", "REDIRECT_URI");
const REFRESH_TOKEN = readEnv("GOOGLE_REFRESH_TOKEN", "REFRESH_TOKEN");
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ = process.env.TZ || "America/Sao_Paulo";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oauth2Client;
}

/**
 * Parse Brazilian date/time from secretary message.
 * Accepts:
 *  - "dd/mm/aa, horário HH:MM"
 *  - "dd/mm/aaaa, horario HH:MM"
 *  - "dd/mm/aa às HH:MM"
 *  - "dd/mm/aa HH:MM"
 */
function parseBRDateTime(message) {
  if (!message) return null;

  // Normalize variations: remove ", horário" / ", horario" / "às"
  const norm = message
    .toLowerCase()
    .replace(/hor[áa]rio/gi, "")
    .replace(/,\s*/g, " ")
    .replace(/\bàs\b/gi, "")
    .replace(/\s{2,}/g, " ");

  // Try dd/mm(/yy|yyyy) HH:MM
  const re = /(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{1,2}):(\d{2})/i;
  const m = norm.match(re);
  if (!m) return null;

  const date = m[1];
  const hh = m[2];
  const mm = m[3];

  let [d, mo, y] = date.split("/");
  if (!y) {
    // if year omitted, use current year
    y = String(new Date().getFullYear());
  } else if (y.length === 2) {
    y = "20" + y;
  }

  // Build local time in Sao Paulo and convert to UTC ISO
  const local = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), 0));
  // crude offset for Sao_Paulo; Railway uses UTC. If TZ is Sao_Paulo, shift +3h.
  const isSP = /Sao_Paulo|SaoPaulo|São_Paulo/i.test(TZ);
  const offsetMinutes = isSP ? 180 : 0;
  const start = new Date(local.getTime() + offsetMinutes * 60000);
  const end = new Date(start.getTime() + 60 * 60000);

  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

/**
 * Cancel the first event found within ±30min of parsed time.
 */
export async function cancelEventFromMessage(message) {
  const parsed = parseBRDateTime(message);
  if (!parsed) {
    return { ok: false, error: "Não consegui entender a data/horário na mensagem." };
  }

  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const center = new Date(parsed.startISO);
    const timeMin = new Date(center.getTime() - 30 * 60000).toISOString();
    const timeMax = new Date(center.getTime() + 30 * 60000).toISOString();

    const list = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });

    const items = list?.data?.items || [];
    if (!items.length) {
      return { ok: false, cancelled: false, error: "Nenhum evento encontrado para cancelar.", timeWindow: { timeMin, timeMax } };
    }

    const event = items[0];
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: event.id,
      sendUpdates: "all",
    });

    return {
      ok: true,
      cancelled: true,
      cancelledEventSummary: event.summary,
      cancelledEventId: event.id,
      timeWindow: { timeMin, timeMax },
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
