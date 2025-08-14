// src/google.esm.js
import { google } from "googleapis";

// ====== CONFIG ======
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ = process.env.TZ || "America/Sao_Paulo";
const CANCEL_LOOKBACK_DAYS = Number(process.env.CANCEL_LOOKBACK_DAYS || 30);

// Cria o cliente OAuth2 com as credenciais do seu app
function getOAuth2() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_REDIRECT_URI = "https://developers.google.com/oauthplayground",
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Faltam variáveis do Google OAuth (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)."
    );
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2;
}

function getCalendar() {
  const auth = getOAuth2();
  return google.calendar({ version: "v3", auth });
}

// Helpers para aceitar Date ou string
function toISO(d) {
  if (!d) return undefined;
  if (typeof d === "string") return d;
  if (d instanceof Date) return d.toISOString();
  throw new Error("Data inválida: use Date ou ISO string.");
}

// =====================
// Checar conflito (freebusy)
// =====================
export async function isSlotFree(start, end, calendarId = CALENDAR_ID) {
  const calendar = getCalendar();
  const timeMin = toISO(start);
  const timeMax = toISO(end);

  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    },
  });

  const busy = resp.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

// =====================
// Criar evento (guarda "phone" em extendedProperties.private)
// =====================
export async function createCalendarEvent({
  summary,
  description,
  start,
  end,
  attendees = [],
  location,
  phone,                  // <-- importante para conseguir cancelar depois
  calendarId = CALENDAR_ID,
}) {
  const calendar = getCalendar();

  const event = {
    summary,
    description,
    start: { dateTime: toISO(start), timeZone: TZ },
    end:   { dateTime: toISO(end),   timeZone: TZ },
    attendees,
    location,
    transparency: "opaque",
    visibility: "private",
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
    extendedProperties: {
      private: phone ? { phone: String(phone) } : {},
    },
  };

  const { data } = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: "all",
  });

  return data; // contém data.id, etc.
}

// =====================
// Cancelar: encontra o próximo evento desse telefone e apaga
// =====================
export async function cancelLatestEventByPhone(phone, calendarId = CALENDAR_ID) {
  if (!phone) throw new Error("phone é obrigatório para cancelar");
  const calendar = getCalendar();

  const now = new Date();
  const timeMin = new Date(now.getTime() - CANCEL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

  // Filtra por propriedade privada gravada na criação
  const resp = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    privateExtendedProperty: `phone=${String(phone)}`,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });

  const items = resp.data.items || [];
  if (items.length === 0) return { ok: false, reason: "not_found" };

  // Cancela o mais próximo (primeiro da lista)
  const target = items[0];

  await calendar.events.delete({
    calendarId,
    eventId: target.id,
    sendUpdates: "all",
  });

  return {
    ok: true,
    canceledEventId: target.id,
    start: target.start,
    end: target.end,
    summary: target.summary,
  };
}
