import { google } from "googleapis";

// Função auxiliar para autenticar no Google Calendar
function getAuth() {
  return new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

// Cancela evento a partir da mensagem recebida da secretária virtual
export async function cancelEventFromMessage(message) {
  try {
    const auth = getAuth();
    auth.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

    const calendar = google.calendar({ version: "v3", auth });

    // Regex adaptado para o formato: "dd/mm/aa, horário HH:MM"
    const regex = /(\d{2}\/\d{2}\/\d{2}).*?(\d{2}:\d{2})/;
    const match = message.match(regex);
    if (!match) {
      return { ok: false, error: "Não consegui entender a data/horário na mensagem." };
    }

    const [_, date, time] = match;
    const [day, month, year] = date.split("/");
    const dateISO = `20${year}-${month}-${day}T${time}:00.000Z`;

    const timeMin = new Date(new Date(dateISO).getTime() - 30 * 60000).toISOString();
    const timeMax = new Date(new Date(dateISO).getTime() + 30 * 60000).toISOString();

    // Buscar evento dentro da janela de tempo
    const events = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });

    if (!events.data.items.length) {
      return { ok: false, error: "Nenhum evento encontrado para cancelar." };
    }

    const event = events.data.items[0];
    await calendar.events.delete({
      calendarId: "primary",
      eventId: event.id,
    });

    return {
      ok: true,
      cancelled: true,
      cancelledEventSummary: event.summary,
      cancelledEventId: event.id,
      timeWindow: { timeMin, timeMax },
    };
  } catch (error) {
    console.error("Erro no cancelamento:", error);
    return { ok: false, error: error.message };
  }
}
