// google.cancel.esm.js
// Autenticação com os MESMOS env vars já usados no seu projeto principal.
import { google } from "googleapis";

function getOAuth2Client() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltam variáveis de ambiente do Google Calendar (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN).");
  }

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

function widenWindow(startISO, endISO, minutes = 30) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const timeMin = new Date(start.getTime() - minutes * 60 * 1000).toISOString();
  const timeMax = new Date(end.getTime() + minutes * 60 * 1000).toISOString();
  return { timeMin, timeMax };
}

/**
 * Cancela o primeiro evento encontrado entre timeMin e timeMax.
 * Retorna { cancelled: true, eventId, summary, timeMin, timeMax } se encontrado.
 */
export async function cancelCalendarEventByDateTime({ calendarId = "primary", startISO, endISO }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const { timeMin, timeMax } = widenWindow(startISO, endISO, 30);

  const { data } = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });

  const events = data.items || [];
  const first = events.find((e) => e.status !== "cancelled");

  if (!first) {
    return { cancelled: false, timeMin, timeMax };
  }

  await calendar.events.delete({
    calendarId,
    eventId: first.id,
    sendUpdates: "all",
  });

  return {
    cancelled: true,
    eventId: first.id,
    summary: first.summary || "",
    timeMin,
    timeMax,
  };
}
