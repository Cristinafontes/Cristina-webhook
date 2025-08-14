import { google } from "googleapis";

function getOAuth2Client() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltam variáveis de ambiente do Google Calendar.");
  }
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

export async function createCalendarEvent({
  summary,
  description,
  startISO,
  endISO,
  attendees = [],
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
}) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: summary || "Consulta",
    description: description || "",
    start: { dateTime: startISO, timeZone: "UTC" },
    end:   { dateTime: endISO,   timeZone: "UTC" },
    attendees: attendees?.length ? attendees : undefined,
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
    transparency: "opaque",
    visibility: "private",
  };

  const { data } = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: "all",
  });
  return data;
}

function toDateSafe(x) { try { return x ? new Date(x) : null; } catch { return null; } }
function diffMinutes(a, b) {
  const A = toDateSafe(a); const B = toDateSafe(b);
  if (!A || !B) return Number.POSITIVE_INFINITY;
  return Math.abs((A.getTime() - B.getTime()) / 60000);
}

export async function findCalendarEvents({
  dateISO,
  timeWindowMinutes = 120,
  timeMin,
  timeMax,
  q,
  maxResults = 25,
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
}) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  let qTimeMin = timeMin;
  let qTimeMax = timeMax;

  // Se recebemos um instante central (dateISO), criamos uma janela ±timeWindowMinutes
  if (dateISO) {
    const center = toDateSafe(dateISO);
    if (center) {
      const half = Math.max(15, Number(timeWindowMinutes) || 120);
      const lo = new Date(center.getTime() - half * 60000);
      const hi = new Date(center.getTime() + half * 60000);
      qTimeMin = lo.toISOString();
      qTimeMax = hi.toISOString();
    }
  }

  // Sem janela explícita → próximos 30 dias
  if (!qTimeMin || !qTimeMax) {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    qTimeMin = now.toISOString();
    qTimeMax = in30.toISOString();
  }

  const res = await calendar.events.list({
    calendarId,
    timeMin: qTimeMin,
    timeMax: qTimeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults,
  });

  let items = res?.data?.items || [];

  // Filtro local por termo, se fornecido
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(ev => {
      const txt = `${ev.summary || ""} ${ev.description || ""} ${ev.location || ""}`.toLowerCase();
      return txt.includes(needle);
    });
  }

  // Ordenar por proximidade do horário alvo
  if (dateISO) {
    items.sort((a, b) => {
      const da = diffMinutes(a.start?.dateTime || a.start?.date, dateISO);
      const db = diffMinutes(b.start?.dateTime || b.start?.date, dateISO);
      return da - db;
    });
  }

  return items.map(ev => ({
    id: ev.id,
    summary: ev.summary,
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    description: ev.description || "",
    location: ev.location || "",
  }));
}

export async function deleteCalendarEvent(eventId, calendarId = process.env.GOOGLE_CALENDAR_ID || "primary") {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId, eventId });
  return true;
}
