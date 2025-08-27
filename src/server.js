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

// =====================
// App
// =====================
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: Railway/Proxies set X-Forwarded-For. Tell Express to trust it.
app.set("trust proxy", 1);

// Segurança + logging + limites
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan(":method :url :status - :response-time ms"));

// Rate limit (after trust proxy)
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Body parsers (Gupshup costuma enviar application/x-www-form-urlencoded)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================
// Memória simples de conversa (em RAM)
// =====================
const conversations = new Map();
function getConversation(id) {
  if (!conversations.has(id)) {
    conversations.set(id, { id, messages: [] });
  }
  return conversations.get(id);
}
function pushMessage(id, role, content) {
  const conv = getConversation(id);
  conv.messages.push({ role, content, ts: Date.now() });
}

// =====================
// Auxiliares de enriquecimento
// =====================
function formatBrazilPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const national = digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length < 10) return digits || "Telefone não informado";

  const ddd = national.slice(0, 2);
  const rest = national.slice(2);

  if (rest.length === 9) {
    return `(${ddd}) ${rest[0]}${rest.slice(1, 5)}-${rest.slice(5)}`;
  }
  if (rest.length === 8) {
    return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
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
    const found = m.content.match(/motivo\s*[:\-]\s*(.+)/i);
    if (found) { reason = found[1].trim(); break; }
  }

  if (!reason) {
    const lastText = (payload?.payload?.text || payload?.payload?.title || payload?.payload?.postbackText || "").trim();
    const f2 = lastText.match(/motivo\s*[:\-]\s*(.+)/i);
    if (f2) reason = f2[1].trim();
  }

  return {
    name,
    phoneFormatted,
    reason: reason || "Motivo não informado",
  };
}

// =====================
// Handler principal (POST do Gupshup)
// =====================
async function handleInbound(req, res) {
  try {
    const p = req.body || {};
    const from = (p?.sender?.phone || p?.sender || p?.source || "unknown").toString();
    const text = (p?.payload?.text || p?.text || "").toString();

    if (text) pushMessage(from, "user", text);

    // tenta extrair data/hora
    const { found, startISO, endISO } = parseCandidateDateTime(text, "America/Sao_Paulo");

    if (found) {
      const conv = getConversation(from);
      const { name, phoneFormatted, reason } = extractPatientInfo({ payload: p, phone: from, conversation: conv });

      const summary = `Consulta – ${name} – ${reason} – ${phoneFormatted}`;
      const description = [
        `Paciente: ${name}`,
        `Telefone: ${phoneFormatted}`,
        `Motivo: ${reason}`,
        `Origem: WhatsApp (Cristina)`,
      ].join("\n");

      await createCalendarEvent({
        summary,
        description,
        startISO,
        endISO,
        attendees: [],
        location: process.env.CLINIC_ADDRESS || "Clínica",
      });

      const humanDate = new Date(startISO).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      await sendWhatsAppText(from, `Perfeito, ${name}! Agendei: ${humanDate}.\nMotivo: ${reason}.`);
      return res.status(200).json({ ok: true });
    }

    const reply = await askCristina(text);
    pushMessage(from, "assistant", reply);
    await sendWhatsAppText(from, reply);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("handleInbound error:", err);
    try { await sendWhatsAppText(process.env.ADMIN_WHATSAPP || "", `Erro no webhook: ${err.message}`); } catch {}
    // Sempre 200 para evitar reenvio em loop
    return res.status(200).json({ ok: true });
  }
}

// =====================
// Rotas
// =====================
// GET helpers (para abrir no navegador sem erro)
app.get("/", (req, res) => res.type("text").send("Cristina webhook online."));
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/webhook/gupshup", (req, res) => res.type("text").send("Use POST em /webhook/gupshup"));

// POST real do Gupshup
app.post("/webhook/gupshup", handleInbound);

// Aliases (opcional)
app.post("/", handleInbound);

// =====================
// Start
// =====================
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));