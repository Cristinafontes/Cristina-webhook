// server.js
// (Este é o server.js original adaptado)
// Importante: inclui fluxo de cancelamento com uso de dateISO no findCalendarEvents quando parseCandidateDateTime encontrar data/hora.

// ... cabeçalho e imports originais ...
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import getRawBody from "raw-body";

import { askCristina } from "./openai.js";
import { sendWhatsAppText } from "./gupshup.js";
import { safeLog } from "./redact.js";

import { createCalendarEvent, findCalendarEvents, deleteCalendarEvent } from "./google.esm.js";
import { parseCandidateDateTime, isCancelIntent } from "./utils.esm.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

// middlewares de segurança etc.
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

// pendingCancel map
const pendingCancel = new Map();
function setPendingCancel(from, options){ const expiresAt = Date.now() + 5*60*1000; pendingCancel.set(from,{expiresAt,options}); }
function getPendingCancel(from){ const it = pendingCancel.get(from); if(!it) return null; if(Date.now()>it.expiresAt){ pendingCancel.delete(from); return null; } return it; }

// handleInbound (resumido só para fluxo de cancelamento)
async function handleInbound(req, res) {
  res.status(200).end();
  const p = req.body?.payload || {};
  const from = p?.sender?.phone || p?.source;
  const text = (p?.payload?.text || "").trim();

  // resposta ao menu
  const previous = getPendingCancel(from);
  if (previous && /^\d+$/.test(text)) {
    const idx = parseInt(text,10)-1;
    const choice = previous.options[idx];
    if (!choice) { await sendWhatsAppText(from,"Número inválido."); return; }
    await deleteCalendarEvent(choice.id);
    await sendWhatsAppText(from,`✅ Agendamento cancelado: ${choice.label}`);
    pendingCancel.delete(from);
    return;
  }

  // nova intenção
  if (isCancelIntent(text)) {
    const parsed = parseCandidateDateTime(text);
    let events = [];
    if (parsed.found) {
      events = await findCalendarEvents({ dateISO: parsed.startISO, q: from });
      if (!events.length) events = await findCalendarEvents({ dateISO: parsed.startISO });
    } else {
      events = await findCalendarEvents({ q: from });
      if (!events.length) events = await findCalendarEvents({});
    }

    if (!events.length) {
      await sendWhatsAppText(from,"Não encontrei agendamento. Informe data e hora (ex.: 30/08 às 14:00)");
      return;
    }
    if (events.length === 1) {
      await deleteCalendarEvent(events[0].id);
      await sendWhatsAppText(from,`✅ Agendamento cancelado: ${events[0].summary} - ${events[0].start}`);
      return;
    }
    const options = events.slice(0,5).map(ev => ({ id: ev.id, label: `${ev.summary||"Consulta"} - ${ev.start}` }));
    setPendingCancel(from, options);
    const menu = options.map((o,i)=>`${i+1}. ${o.label}`).join("\n");
    await sendWhatsAppText(from,`Encontrei mais de um agendamento:\n\n${menu}\n\nResponda com o número.`);
    return;
  }

  // ... resto do fluxo original ...
}

app.post("/webhook/gupshup", handleInbound);
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
