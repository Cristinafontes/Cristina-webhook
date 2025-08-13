import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const calendar = google.calendar({ version: "v3" });
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

async function listEventsInRange(start, end) {
  await auth.authorize();
  const res = await calendar.events.list({
    auth,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });
  return res.data.items || [];
}

export async function isSlotFree(start, end) {
  const events = await listEventsInRange(start, end);
  return events.length === 0;
}

export async function createCalendarEvent({ summary, description, start, end, phone }) {
  await auth.authorize();
  await calendar.events.insert({
    auth,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
      extendedProperties: { private: { phone: String(phone || "") } }
    }
  });
}

export async function cancelLatestEventByPhone(phone) {
  await auth.authorize();
  const now = new Date();
  const res = await calendar.events.list({
    auth,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: now.toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: "startTime"
  });

  const events = res.data.items || [];
  const found = events.find(ev => ev.extendedProperties?.private?.phone === String(phone));
  if (!found) return false;

  await calendar.events.delete({
    auth,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: found.id
  });
  return true;
}
