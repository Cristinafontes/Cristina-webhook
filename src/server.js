import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";

import { askCristina } from "./openai.js";
import { sendWhatsAppText } from "./gupshup.js";
import { safeLog } from "./redact.js";

// >>> CALENDÁRIO
import { createCalendarEvent } from "./google.esm.js";
import { parseCandidateDateTime } from "./utils.esm.js";

dotenv.config();

const DEBUG_WEBHOOK = String(process.env.DEBUG_WEBHOOK || "").toLowerCase() === "true";

// =====================
// App
// =====================
const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan(":method :url :status - :response-time ms"));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Accept both JSON and form-encoded
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));

// ---------------------
// Helpers
// ---------------------
function formatBrazilPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const national = digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length < 10) return digits || "Telefone não informado";
  const ddd = national.slice(0, 2);
  const rest = national.slice(2);
  if (rest.length === 9) return `(${ddd}) ${rest[0]}${rest.slice(1, 5)}-${rest.slice(5)}`;
  if (rest.length === 8) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  return `(${ddd}) ${rest}`;
}

function extractPatientInfo({ payload, phone, conversation }) {
  const name = (payload?.sender?.name || "Paciente (WhatsApp)").toString().trim();
  const phoneFormatted = formatBrazilPhone(phone || payload?.sender?.phone || payload?.source);
  let reason = null;
  const msgs = conversation?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const found = m.content?.match?.(/motivo\s*[:\-]\s*(.+)/i);
    if (found) { reason = found[1].trim(); break; }
  }
  if (!reason) {
    const lastText = (payload?.payload?.text || payload?.payload?.title || payload?.payload?.postbackText || "").trim?.() || "";
    const f2 = lastText.match(/motivo\s*[:\-]\s*(.+)/i);
    if (f2) reason = f2[1].trim();
  }
  return { name, phoneFormatted, reason: reason || "Motivo não informado" };
}

// Coerce various bodies Gupshup may send
function normalizePayload(p) {
  // Some providers send payload as JSON string
  if (p && typeof p.payload === "string") {
    try { p.payload = JSON.parse(p.payload); } catch {}
  }
  if (p && typeof p.sender === "string") {
    // sometimes sender is a phone string
    p.sender = { phone: p.sender };
  }
  return p || {};
}

function getIncomingText(p) {
  // Try many paths safely
  const candidates = [
    p?.payload?.text,
    p?.text,
    p?.message?.text,
    p?.message?.payload?.text,
    p?.payload?.payload?.text, // double nested
    p?.payload?.message?.text,
    p?.payload?.postbackText,
    p?.postbackText,
  ].filter(Boolean);
  if (candidates.length) return String(candidates[0]);
  // Fallback: join known string fields
  const flat = [p?.message, p?.payload, p?.text].map(x => (typeof x === "string" ? x : null)).filter(Boolean);
  if (flat.length) return flat[0];
  return "";
}

// Memory
const conversations = new Map();
function getConversation(id) { if (!conversations.has(id)) conversations.set(id, { id, messages: [] }); return conversations.get(id); }
function pushMessage(id, role, content) { const c = getConversation(id); c.messages.push({ role, content, ts: Date.now() }); }

// ---------------------
// Handler
// ---------------------
async function handleInbound(req, res) {
  try {
    let p = normalizePayload(req.body || {});
    const from = (p?.sender?.phone || p?.sender || p?.source || "unknown").toString();
    const text = getIncomingText(p);

    if (DEBUG_WEBHOOK) {
      console.log("DEBUG incoming body:", JSON.stringify(p).slice(0, 4000));
    }

    if (text) pushMessage(from, "user", text);

    // Debug echo to verify round-trip
    if (DEBUG_WEBHOOK) {
      await safeSend(from, `DEBUG: recebi sua mensagem: "${text}"`);
    }

    // Try parse date/time
    const { found, startISO, endISO } = parseCandidateDateTime(text, "America/Sao_Paulo");

    if (found) {
      const conv = getConversation(from);
      const { name, phoneFormatted, reason } = extractPatientInfo({ payload: p, phone: from, conversation: conv });
      const summary = `Consulta – ${name} – ${reason} – ${phoneFormatted}`;
      const description = [`Paciente: ${name}`, `Telefone: ${phoneFormatted}`, `Motivo: ${reason}`, `Origem: WhatsApp (Cristina)`].join("\\n");

      await createCalendarEvent({ summary, description, startISO, endISO, attendees: [], location: process.env.CLINIC_ADDRESS || "Clínica" });

      const humanDate = new Date(startISO).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      await safeSend(from, `Perfeito, ${name}! Agendei: ${humanDate}.\nMotivo: ${reason}.`);
      return res.status(200).json({ ok: true });
    }

    // Ask LLM for next message
    const reply = await askCristina(text);
    pushMessage(from, "assistant", reply);
    await safeSend(from, reply);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("handleInbound error:", err);
    try { await safeSend(process.env.ADMIN_WHATSAPP || "", `Erro no webhook: ${err.message}`); } catch {}
    return res.status(200).json({ ok: true });
  }
}

async function safeSend(to, message) {
  try {
    if (!to || !message) return;
    await sendWhatsAppText(to, message);
  } catch (e) {
    console.error("sendWhatsAppText failed:", e?.response?.data || e?.message || e);
  }
}

// ---------------------
// Routes
// ---------------------
app.get("/", (req, res) => res.type("text").send("Cristina webhook online."));
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/webhook/gupshup", (req, res) => res.type("text").send("Use POST em /webhook/gupshup"));

app.post("/webhook/gupshup", handleInbound);
app.post("/", handleInbound);

// ---------------------
// Start
// ---------------------
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));