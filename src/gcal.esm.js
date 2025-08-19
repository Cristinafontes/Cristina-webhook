import { google } from "googleapis"

/** Lê envs com e sem prefixo GOOGLE_ */
function env(a, b) { return process.env[a] || process.env[b] || ""; }
const CLIENT_ID     = env("GOOGLE_CLIENT_ID", "CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET", "CLIENT_SECRET");
const REDIRECT_URI  = env("GOOGLE_REDIRECT_URI", "REDIRECT_URI");
const REFRESH_TOKEN = env("GOOGLE_REFRESH_TOKEN", "REFRESH_TOKEN");
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ            = process.env.TZ || "America/Sao_Paulo";

function auth() {
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

/**
 * Normaliza e extrai data/hora de frases em PT-BR.
 * Aceita:
 * - "dd/mm/aa, horário HH:MM"
 * - "dd/mm/aaaa, horario HH:MM"
 * - "dd/mm/aa às HH:MM"
 * - "dd/mm/aa HH:MM"
 * - "dd/mm/aa HHh" ou "HHh30"
 */
function parseBRDateTime(message) {
  if (!message) return null;
  let norm = String(message)
    .toLowerCase()
    .replace(/hor[aá]rio/gi, "")   // remove "horario" / "horário"
    .replace(/\bàs\b/gi, "")       // remove "às"
    .replace(/,/g, " ")            // troca vírgula por espaço
    .replace(/\s{2,}/g, " ")       // remove espaços extras
    .trim();

  // 1) HH:MM
  let m = norm.match(/(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{1,2}):(\d{2})/i);
  if (!m) {
    // 2) HHhMM ou HHh
    m = norm.match(/(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{1,2})h(?:(\d{2}))?/i);
  }
  if (!m) return null;

  const date = m[1];
  const HH = Number(m[2]);
  const MM = Number(m[3] || 0);

  let [d, mo, y] = date.split("/");
  if (!y) y = String(new Date().getFullYear());
  if (y.length === 2) y = "20" + y;

  // Monta horário local de SP e converte para UTC ISO (offset fixo 3h p/ simplicidade)
  const baseUTC = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), HH, MM, 0));
  const isSP = /Sao_Paulo|São_Paulo|SaoPaulo/i.test(TZ);
  const offsetMin = isSP ? 180 : 0;
  const startISO = new Date(baseUTC.getTime() + offsetMin * 60000).toISOString();
  const endISO   = new Date(new Date(startISO).getTime() + 60 * 60000).toISOString();
  return { startISO, endISO };
}

/** Cancela o primeiro evento em ±30min do horário extraído. */
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
