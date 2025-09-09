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
