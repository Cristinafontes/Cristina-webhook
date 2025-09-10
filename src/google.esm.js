// google.esm.js
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

export async function pingGoogle() {
  const auth = getOAuth2Client();
  const token = await auth.getAccessToken();
  return !!token;
}

export async function createCalendarEvent({
  summary,
  description,
  startISO,
  endISO,
  attendees = [],
  location,
  calendarId: calendarIdParam,      // aceita vir de fora
  extendedProperties,               // << NOVO
}) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = calendarIdParam || process.env.GOOGLE_CALENDAR_ID || "primary";

  const event = {
    summary,
    description,
    location,
    start: { dateTime: startISO },
    end:   { dateTime: endISO },
    attendees,
    reminders: { useDefault: false },
    ...(extendedProperties ? { extendedProperties } : {}), // << NOVO
  };

  const res = await calendar.events.insert({
    calendarId,
    resource: event,
    sendUpdates: "all",
  });
  return res?.data;
}

// Busca eventos por telefone (em description) e filtra por nome
export async function findPatientEvents({
  calendarId,
  phone,
  name,
  daysBack = 30,
  daysAhead = 180,
}) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const calId = calendarId || process.env.GOOGLE_CALENDAR_ID || "primary";

  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 86400000).toISOString();
  const timeMax = new Date(now.getTime() + daysAhead * 86400000).toISOString();

  // busca pelo telefone (que gravamos em description como #patient_phone:<número>)
  const q = String(phone || "").trim();
  const res = await calendar.events.list({
  calendarId: calId,
  singleEvents: true,
  showDeleted: false,
  orderBy: "startTime",
  timeMin,
  timeMax,
  maxResults: 250,   // aumenta o teto para não perder eventos
});

  const items = res?.data?.items || [];
  const nameNorm   = String(name || "").trim().toLowerCase();
const phoneDigits = String(phone || "").replace(/\D/g, "");

const filtered = items.filter((ev) => {
  const desc = String(ev.description || "");
  const sum  = String(ev.summary || "");
  const descLower  = desc.toLowerCase();
  const sumLower   = sum.toLowerCase();
  const descDigits = desc.replace(/\D/g, "");

  // Telefone OK se: tem o tag OU os dígitos aparecem na descrição formatada
  const phoneOk = phoneDigits
    ? (descLower.includes(`#patient_phone:${phoneDigits}`) ||
       /#patient_phone:\d+/.test(descLower) ||
       (phoneDigits && descDigits.includes(phoneDigits)))
    : true;

  // Nome OK se aparece no título/descrição ou no tag
  const nameOk = nameNorm
    ? (descLower.includes(nameNorm) ||
       sumLower.includes(nameNorm) ||
       descLower.includes(`#patient_name:${nameNorm}`))
    : true;

  return phoneOk && nameOk;
});



  return filtered.map((ev) => {
    const startISO =
      ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
    const dt = startISO ? new Date(startISO) : null;
    const dd = dt ? String(dt.getDate()).padStart(2, "0") : "";
    const mm = dt ? String(dt.getMonth() + 1).padStart(2, "0") : "";
    const hh = dt ? String(dt.getHours()).padStart(2, "0") : "";
    const mi = dt ? String(dt.getMinutes()).padStart(2, "0") : "";
    return {
      id: ev.id,
      summary: ev.summary || "",
      description: ev.description || "",
      startISO,
      endISO: ev.end?.dateTime || null,
      dayLabel: dt ? `${dd}/${mm}` : "",
      timeLabel: dt ? `${hh}:${mi}` : "",
    };
  });
}

// Cancela um evento pelo ID (status = "cancelled")
export async function cancelCalendarEvent({ calendarId, eventId }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const calId = calendarId || process.env.GOOGLE_CALENDAR_ID || "primary";

  await calendar.events.patch({
    calendarId: calId,
    eventId,
    resource: { status: "cancelled" },
    sendUpdates: "all", // notifica convidados (opcional)
  });
}
