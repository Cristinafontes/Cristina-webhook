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
import { createCalendarEvent, cancelLatestEventByPhone, isSlotFree } from "./google.esm.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : "*",
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

app.use(async (req, res, next) => {
  const method = (req.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) return next();

  try {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    const raw = await getRawBody(req);
    req.rawBody = raw;
    const text = raw.toString("utf8") || "";

    if (ct.includes("application/json")) {
      req.body = text ? JSON.parse(text) : {};
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(text);
      const body = {};
      for (const [k, v] of params) body[k] = v;
      if (typeof body.payload === "string") {
        try { body.payload = JSON.parse(body.payload); } catch {}
      }
      req.body = body;
    } else {
      req.body = {};
    }
    return next();
  } catch {
    res.status(200).end();
  }
});

app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "Cristina WhatsApp Webhook" }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/webhook/gupshup", (_req, res) => res.status(200).send("ok"));

const conversations = new Map();
const MEMORY_TTL_HOURS = Number(process.env.MEMORY_TTL_HOURS || 24);
const MEMORY_MAX_MESSAGES = Number(process.env.MEMORY_MAX_MESSAGES || 20);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 20000);

function nowMs() { return Date.now(); }
function getConversation(phone) {
  const c = conversations.get(phone);
  if (!c) return null;
  const ageHours = (nowMs() - c.updatedAt) / (1000 * 60 * 60);
  if (ageHours > MEMORY_TTL_HOURS) {
    conversations.delete(phone);
    return null;
  }
  return c;
}
function ensureConversation(phone) {
  const existing = getConversation(phone);
  if (existing) return existing;
  const c = { updatedAt: nowMs(), messages: [] };
  conversations.set(phone, c);
  return c;
}
function trimToLastN(arr, n) {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}
function appendMessage(phone, role, content) {
  const conv = ensureConversation(phone);
  conv.messages.push({ role, content: String(content || "").slice(0, 4000) });
  conv.messages = trimToLastN(conv.messages, MEMORY_MAX_MESSAGES);
  conv.updatedAt = nowMs();
}
function resetConversation(phone) { conversations.delete(phone); }

setInterval(() => {
  const cutoff = nowMs() - MEMORY_TTL_HOURS * 60 * 60 * 1000;
  for (const [k, v] of conversations.entries()) {
    if (v.updatedAt < cutoff) conversations.delete(k);
  }
}, 30 * 60 * 1000);

async function handleInbound(req, res) {
  res.status(200).end();

  try {
    const eventType = req.body?.type || req.body?.event || null;
    if (eventType !== "message") return;

    const p = req.body?.payload || {};
    const msgType = p?.type;
    const from = p?.sender?.phone || p?.source;
    if (!from) return;

    let userText = "";
    if (msgType === "text") {
      userText = p?.payload?.text || "";
    } else if (msgType === "button_reply" || msgType === "list_reply") {
      userText = p?.payload?.title || p?.payload?.postbackText || "";
    } else {
      await sendWhatsAppText({ to: from, text: "Por ora, consigo ler apenas mensagens de texto." });
      return;
    }

    safeLog("INBOUND", req.body);

    const trimmed = userText.trim().toLowerCase();
    if (["reset", "reiniciar", "novo atendimento"].includes(trimmed)) {
      resetConversation(from);
      await sendWhatsAppText({ to: from, text: "Conversa reiniciada. Como posso ajudar?" });
      return;
    }
    if (trimmed.includes("cancelar")) {
      const canceled = await cancelLatestEventByPhone(from);
      await sendWhatsAppText({ to: from, text: canceled ? "Consulta cancelada com sucesso." : "Não encontrei consulta para cancelar." });
      return;
    }

    if (/^pronto! sua consulta com a dra\. jenifer está agendada para o dia (\d{2}\/\d{2}\/\d{2}), horário (\d{2}:\d{2})/i.test(userText)) {
      const [, dateStr, timeStr] = userText.match(/(\d{2}\/\d{2}\/\d{2}).*?(\d{2}:\d{2})/);
      const [day, month, year] = dateStr.split("/").map(Number);
      const [hour, minute] = timeStr.split(":").map(Number);
      const start = new Date(2000 + year, month - 1, day, hour, minute);
      const end = new Date(start.getTime() + (Number(process.env.SLOT_MINUTES || 60) * 60000));
      const slotOk = await isSlotFree(start, end);
      if (!slotOk) {
        await sendWhatsAppText({ to: from, text: "Esse horário já está ocupado! Escolha outro." });
        return;
      }
      await createCalendarEvent({
        summary: `Consulta Dra. Jenifer`,
        description: `Agendada via Cristina para ${from}`,
        start,
        end,
        phone: from
      });
      return;
    }

    const conv = getConversation(from);
    let composed;
    if (conv && conv.messages.length > 0) {
      const lines = conv.messages.map(m => m.role === "user" ? `Paciente: ${m.content}` : `Cristina: ${m.content}`);
      lines.push(`Paciente: ${userText}`);
      let body = lines.join("\n");
      if (body.length > MAX_CONTEXT_CHARS) {
        const rev = lines.slice().reverse();
        const kept = [];
        let total = 0;
        for (const line of rev) {
          total += line.length + 1;
          if (total > MAX_CONTEXT_CHARS) break;
          kept.push(line);
        }
        body = kept.reverse().join("\n");
      }
      composed = `Contexto de conversa:\n${body}\n\nResponda de forma consistente com o histórico.`;
    } else {
      composed = userText;
    }

    const answer = await askCristina({ userText: composed, userPhone: String(from) });
    appendMessage(from, "user", userText);
    if (answer) {
      appendMessage(from, "assistant", answer);
      await sendWhatsAppText({ to: from, text: answer });
    }
  } catch (err) {
    console.error("ERR inbound:", err?.response?.data || err);
  }
}

app.post("/webhook/gupshup", handleInbound);
app.post("/healthz", handleInbound);
app.post("/", handleInbound);

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
