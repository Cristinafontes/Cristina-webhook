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

export async function createCalendarEvent({ summary, description, startISO, endISO, attendees = [], location }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  const event = {
    summary,
    description,
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    attendees,
    location,
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

// === Funções adicionais de busca e cancelamento ===
export async function deleteCalendarEvent(eventId, calendarId = process.env.GOOGLE_CALENDAR_ID) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId, eventId });
  return true;
}

export async function findCalendarEvents({ timeMin, timeMax, q, maxResults = 10, calendarId = process.env.GOOGLE_CALENDAR_ID }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults,
  });
  let items = res?.data?.items || [];
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(ev => {
      const txt = `${ev.summary||""} ${ev.description||""} ${ev.location||""}`.toLowerCase();
      return txt.includes(needle);
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
