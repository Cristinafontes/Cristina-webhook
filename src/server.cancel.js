// src/server.cancel.js
// Microservidor exclusivo para CANCELAMENTO de eventos no Google Calendar.
// NÃO altera tokens, secrets ou layout já existente.
// Rode separado: node src/server.cancel.js

const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

// ==== ENVs (os mesmos que já usa no projeto) ====
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,   // opcional
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,
  CANCEL_SERVER_PORT     // default 4002
} = process.env;

// ==== Funções auxiliares ====
function pad2(n){ return String(n).padStart(2,"0"); }
function toISOFromPtBr(dateStr, timeStr, tzOffsetHours = -3) {
  const [d,m,yRaw] = dateStr.split("/");
  const y = yRaw.length === 2 ? ("20" + yRaw) : yRaw;
  const [hh,mm] = timeStr.split(":").map(v=>parseInt(v,10));
  const sign = tzOffsetHours >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetHours);
  const tz = `${sign}${pad2(abs)}:00`;
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:00${tz}`;
}

function getOAuth2Client() {
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob"
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

async function findEventByHints(calendar, { calendarId, date, time, doctorName, patientName }) {
  const centerISO = toISOFromPtBr(date, time);
  const center = new Date(centerISO);
  const start = new Date(center.getTime() - 90*60*1000);
  const end   = new Date(center.getTime() + 90*60*1000);

  const list = await calendar.events.list({
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: "startTime"
  });

  const items = list.data.items || [];
  if (!items.length) return null;

  const norm = s => (s||"").toLowerCase();
  const dName = norm(doctorName), pName = norm(patientName);

  const scored = items.map(ev=>{
    let score=0;
    const summary=norm(ev.summary), desc=norm(ev.description);
    if(dName){ if(summary.includes(dName)) score+=2; if(desc.includes(dName)) score+=1; }
    if(pName){ if(summary.includes(pName)) score+=2; if(desc.includes(pName)) score+=1; }
    const startStr=ev.start?.dateTime||ev.start?.date;
    const diff=Math.abs(new Date(startStr)-center);
    score -= (diff/60000)/30;
    return {ev,score,diff};
  });

  scored.sort((a,b)=> (b.score-a.score)||(a.diff-b.diff));
  return scored[0]?.ev||null;
}

async function cancelGoogleEvent({ eventId, doctorName, patientName, date, time }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  let targetEventId = eventId;

  if(!targetEventId){
    const candidate = await findEventByHints(calendar, {
      calendarId: GOOGLE_CALENDAR_ID, date, time, doctorName, patientName
    });
    if(!candidate) throw new Error("Não encontrei evento para cancelar.");
    targetEventId = candidate.id;
  }

  await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: targetEventId });

  return {
    deletedEventId: targetEventId,
    message: `Pronto! Sua consulta com a ${doctorName||"sua médica"} foi cancelada no dia ${date}, horário ${time}.`
  };
}

// ==== App Express ====
const app = express();
app.use(bodyParser.json());

app.get("/healthz", (_req,res)=>res.send("ok"));

app.post("/webhook/cancel", async (req,res)=>{
  try{
    const {eventId,doctorName,patientName,date,time} = req.body||{};
    const {message,deletedEventId} = await cancelGoogleEvent({eventId,doctorName,patientName,date,time});
    res.json({ok:true,deletedEventId,reply:message});
  }catch(err){
    console.error("[cancel] error:",err);
    res.status(400).json({ok:false,error:err.message});
  }
});

const PORT = Number(CANCEL_SERVER_PORT)||4002;
app.listen(PORT, ()=> console.log(`[cancel] listening on :${PORT}`));
