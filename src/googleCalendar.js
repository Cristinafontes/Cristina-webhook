import { google } from "googleapis";

function getAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  ).setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

export async function createEvent({ startISO, endISO, nome, telefone, modalidade }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const summary = `Consulta Dra. Jenifer [${startISO.slice(0,10).split('-').reverse().join('/')}] - Paciente ${nome} e telefone ${telefone} (${modalidade})`;

  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    requestBody: {
      summary,
      start: { dateTime: startISO },
      end: { dateTime: endISO }
    }
  });
}

export async function cancelEvent({ startISO, endISO, titleContains }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    q: titleContains
  });

  const event = res.data.items.find(e => (e.summary || "").includes(titleContains));
  if (event) {
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      eventId: event.id
    });
  }
}
