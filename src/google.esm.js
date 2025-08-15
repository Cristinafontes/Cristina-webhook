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

function getCalendar() {
  const auth = getOAuth2Client();
  return google.calendar({ version: "v3", auth });
}

export async function isSlotFree({ calendarId = process.env.GOOGLE_CALENDAR_ID || "primary", startISO, endISO }) {
  const calendar = getCalendar();
  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      items: [{ id: calendarId }],
    },
  });
  const busy = data?.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

export async function createCalendarEvent({
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
  startISO,
  endISO,
  patientName,
  patientPhone,
  summary,
  description,
  location,
}) {
  const calendar = getCalendar();

  // Checagem de conflito
  const free = await isSlotFree({ calendarId, startISO, endISO });
  if (!free) {
    return { conflict: true };
  }

  const event = {
    summary: summary || "Consulta",
    description: description || "Agendado automaticamente pela secretária virtual.",
    start: { dateTime: startISO, timeZone: "UTC" },
    end: { dateTime: endISO, timeZone: "UTC" },
    location: location || process.env.CLINIC_ADDRESS || "Clínica",
    extendedProperties: {
      private: {
        phone: patientPhone || "",
        patientName: patientName || "",
        source: "Cristina",
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
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
  return { event: data, conflict: false };
}

export async function listEventsAround({
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
  startISO,
  endISO,
}) {
  const calendar = getCalendar();
  const { data } = await calendar.events.list({
    calendarId,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
  });
  return data?.items || [];
}

export async function findAndCancelEvent({
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
  targetStartISO,
  phoneHint,
}) {
  // Buscamos numa janela +- 2h em torno do horário alvo
  const start = new Date(new Date(targetStartISO).getTime() - 2 * 60 * 60 * 1000).toISOString();
  const end = new Date(new Date(targetStartISO).getTime() + 2 * 60 * 60 * 1000).toISOString();
  const items = await listEventsAround({ calendarId, startISO: start, endISO: end });
  if (!items.length) return { found: false };

  const phoneLast4 = String(phoneHint || "").slice(-4);
  const match = items.find(ev => {
    const evStart = ev?.start?.dateTime || ev?.start?.date;
    const sameStart = evStart && Math.abs(new Date(evStart) - new Date(targetStartISO)) < (30 * 60 * 1000);
    const privPhone = ev?.extendedProperties?.private?.phone || "";
    const desc = ev?.description || "";
    const sum = ev?.summary || "";
    const anyPhone = [privPhone, desc, sum].some(s => String(s).includes(phoneLast4));
    return sameStart && (anyPhone || !phoneLast4);
  });

  if (!match) return { found: false };
  const calendar = getCalendar();
  await calendar.events.delete({ calendarId, eventId: match.id, sendUpdates: "all" });
  return { found: true, cancelledId: match.id, summary: match.summary };
}
