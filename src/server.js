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

// >>> CALENDÁRIO (somente nossas funções)
import { createCalendarEvent } from "./google.esm.js";
import { parseCandidateDateTime } from "./utils.esm.js";
// <<< FIM CALENDÁRIO

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

// =====================
// Security & middleware
// =====================
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

// =====================================
// Tolerant body parser (JSON + FORM-URL)
// =====================================
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
  } catch (e) {
    console.error("Parser error:", e);
    res.status(200).end();
  }
});

// =====================
// Health & validations
// =====================
app.get("/", (_req, res) =>
  res.status(200).json({ ok: true, service: "Cristina WhatsApp Webhook" })
);
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/webhook/gupshup", (_req, res) => res.status(200).send("ok"));

// =====================
// Memória por telefone
// =====================
const MEMORY_TTL_HOURS = Number(process.env.MEMORY_TTL_HOURS || 24);
const MEMORY_MAX_MESSAGES = Number(process.env.MEMORY_MAX_MESSAGES || 20);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 20000);

const conversations = new Map();

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

function formatBrazilPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const national = digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length < 10) return digits || "Telefone não informado";

  const ddd = national.slice(0, 2);
  const rest = national.slice(2);

  // 9 dígitos (celular) => 9XXXX-XXXX
  if (rest.length === 9) {
    return `(${ddd}) ${rest[0]}${rest.slice(1, 5)}-${rest.slice(5)}`;
  }
  // 8 dígitos (fixo) => XXXX-XXXX
  if (rest.length === 8) {
    return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  // fallback (10+ dígitos)
  return `(${ddd}) ${rest}`;
}

/**
 * Tenta extrair Nome, Telefone e Motivo.
 * - Nome e Telefone: do próprio payload do WhatsApp (quando possível)
 * - Motivo: procura por linhas no histórico do paciente do tipo dor... avaliação...  (com ou sem maiúsculas)".
 */

function extractPatientInfo({ payload, phone, conversation }) {
  const name = (payload?.sender?.name || "Paciente (WhatsApp)").toString().trim();
  const phoneFormatted = formatBrazilPhone(phone || payload?.sender?.phone || payload?.source);

  // 2.1 – Primeiro tenta "Motivo: ..."
  let reason = null;
  const msgs = conversation?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const found = m.content?.match?.(/motivo\s*[:\-]\s*(.+)/i);
    if (found) { reason = found[1].trim(); break; }
  }

  // 2.2 – Se não veio "Motivo:", tenta inferir por frases ("dor lombar", "avaliação pré-anestésica")
  if (!reason) {
    // Olha das últimas mensagens do usuário para trás
    for (let i = msgs.length - 1; i >= 0 && !reason; i--) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      reason = inferReasonFromText(m.content);
    }
  }

  // 2.3 – Última tentativa: olhar o payload mais recente
  if (!reason) {
    const lastText =
      (payload?.payload?.text ||
       payload?.payload?.title ||
       payload?.payload?.postbackText ||
       payload?.text ||
       "") + "";
    // Primeiro tenta "Motivo: ...", depois inferência
    const m = lastText.match(/motivo\s*[:\-]\s*(.+)/i);
    reason = m ? m[1].trim() : inferReasonFromText(lastText);
  }

  return {
    name,
    phoneFormatted,
    reason: reason || "Motivo não informado",
  };
}

// Tenta entender o motivo a partir de frases como "dor lombar", "avaliação pré-anestésica" etc.
function inferReasonFromText(raw) {
  const text = String(raw || "");
  const norm = text
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase();

  // 1) Avaliação pré-anestésica (variações)
  if (
    /\bavaliac\w*\s+pre[-\s]?anest(e|es|esi|esic|esica|esia)/.test(norm) ||
    /\bpre[-\s]?anest(e|es|esi|esic|esica|esia)/.test(norm)
  ) {
    return "Avaliação pré-anestésica";
  }

  // 2) Dor + região (tenta capturar o que vem depois de "dor")
  // Ex.: "dor lombar", "dor no ombro direito", "dor cervical há 2 meses"
  const m = text.match(/(?:^|\b)dor(?:\s+(?:no|na|em|de))?\s+([a-zA-ZÀ-ÿ\- ]{2,40})/i);
  if (m) {
    // Limpa terminação comum que não agrega
    let region = m[1]
      .replace(/\s+(ha|há)\s+\d+.*/i, "")       // remove "há 2 meses..."
      .replace(/[.,;].*$/, "")                  // corta na primeira pontuação
      .trim();

    // Se a região ficou muito genérica, tenta melhorias por palavras-chave
    const n2 = region.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (/lomb/.test(n2)) region = "lombar";
    else if (/cerv/.test(n2)) region = "cervical";
    else if (/ombro/.test(n2)) region = "ombro";
    else if (/joelh/.test(n2)) region = "joelho";
    else if (/(cabec|cefale)/.test(n2)) region = "cabeça";
    else if (/coluna/.test(n2)) region = "coluna";

    return `Dor ${region}`.trim();
  }

  // 3) Palavras-chave soltas de dor (quando não deu para capturar a região)
  if (/\bdor(es)?\b/.test(norm)) return "Dor";

  // 4) Outros motivos comuns que queira mapear (exemplos):
  if (/\bpos[-\s]?op(eratori[oa])?\b/.test(norm)) return "Avaliação pós-operatória";
  if (/\bneuropat/.test(norm)) return "Dor neuropática";

  return null; // não conseguiu inferir
}

function trimToLastN(arr, n) {
  if (arr.length <= n) return arr;
  return arr.slice(arr.length - n);
}

function appendMessage(phone, role, content) {
  const conv = ensureConversation(phone);
  conv.messages.push({ role, content: String(content || "").slice(0, 4000) });
  conv.messages = trimToLastN(conv.messages, MEMORY_MAX_MESSAGES);
  conv.updatedAt = nowMs();
}

function resetConversation(phone) {
  conversations.delete(phone);
}

setInterval(() => {
  const cutoff = nowMs() - MEMORY_TTL_HOURS * 60 * 60 * 1000;
  for (const [k, v] of conversations.entries()) {
    if (v.updatedAt < cutoff) conversations.delete(k);
  }
}, 30 * 60 * 1000);

// =====================
// Inbound handler
// =====================
async function handleInbound(req, res) {
  res.status(200).end();

  try {
    console.log(
      "[WEBHOOK HIT]",
      new Date().toISOString(),
      "method=", req.method,
      "ct=", req.headers["content-type"],
      "keys=", Object.keys(req.body || {})
    );

    const eventType = req.body?.type || req.body?.event || null;
    if (eventType !== "message") return;

    const p = req.body?.payload || {};
    const msgType = p?.type;
    const from = p?.sender?.phone || p?.source;
    if (!from) return;

    // Extrai texto
    let userText = "";
    if (msgType === "text") {
      userText = p?.payload?.text || "";
    } else if (msgType === "button_reply" || msgType === "list_reply") {
      userText = p?.payload?.title || p?.payload?.postbackText || "";
    } else {
      await sendWhatsAppText({
        to: from,
        text: "Por ora, consigo ler apenas mensagens de texto. Pode tentar novamente?",
      });
      return;
    }

    safeLog("INBOUND", req.body);

    const trimmed = (userText || "").trim().toLowerCase();
    if (["reset", "reiniciar", "reiniciar conversa", "novo atendimento"].includes(trimmed)) {
      resetConversation(from);
      await sendWhatsAppText({ to: from, text: "Conversa reiniciada. Como posso ajudar?" });
      return;
    }

    // Montagem de contexto para a IA
    const conv = getConversation(from);
    let composed;

    if (conv && conv.messages.length > 0) {
      const lines = conv.messages.map(m =>
        m.role === "user" ? `Paciente: ${m.content}` : `Cristina: ${m.content}`
      );
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

      composed =
        `Contexto de conversa (mais recente por último):\n` +
        `${body}\n\n` +
        `Responda de forma consistente com o histórico, mantendo o tom e as regras da clínica.`;
    } else {
      composed = userText;
    }

    // Resposta da secretária (IA)
    const answer = await askCristina({ userText: composed, userPhone: String(from) });

    
    // ======== DISPARO DE CANCELAMENTO (formato EXATO) ========
    // "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia dd/mm/aa HH:MM"
    try {
      const cancelRegex = /^Pronto!\s*Sua consulta com a Dra\.?\s*Jenifer está cancelada para o dia\s+(\d{2})\/(\d{2})\/(\d{2})\s+(\d{1,2}:\d{2})\.?$/i;
      if (answer && cancelRegex.test(answer)) {
        const cancelURLBase = process.env.CANCEL_SERVER_URL || "https://charming-growth-production.up.railway.app";
        const endpoint = `${cancelURLBase.replace(/\/+$/,'')}/cancel-from-message`;
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: answer }),
        });
        const jr = await r.json().catch(() => ({}));
        console.log("[cancel-forward] sent to:", endpoint, "response:", jr);
      }
    } catch (err) {
      console.error("[cancel-forward] error:", err?.message || err);
    }
    // ======== FIM DO DISPARO DE CANCELAMENTO ========
// ======== SÓ CRIA EVENTO SE A SECRETÁRIA CONFIRMAR NESSE FORMATO ========
    // "Pronto! Sua consulta com a Dra. Jenifer está agendada para o dia 30/08/25, horário 14:00."
    const confirmRegex =
      /pronto!\s*sua\s+consulta\s+com\s+a\s+dra\.?\s+jenifer\s+est[aá]\s+agendada\s+para\s+o\s+dia\s+(\d{1,2})\/(\d{1,2})\/\d{2}\s*,?\s*hor[áa]rio\s+(\d{1,2}:\d{2}|\d{1,2}h)/i;

    if (answer) {
      const m = answer.match(confirmRegex);
      if (m) {
        try {
          const dd = m[1].padStart(2, "0");
          const mm = m[2].padStart(2, "0");
          let hhmm = m[3];

          // Normaliza "14h" -> "14:00"
          if (/^\d{1,2}h$/i.test(hhmm)) {
            hhmm = hhmm.replace(/h$/i, ":00");
          }

          // Monta um texto que o nosso parser (utils.esm.js) entende
          // Obs.: ele usa o ANO ATUAL por padrão.
          const textForParser = `${dd}/${mm} ${hhmm}`;

          const { found, startISO, endISO } = parseCandidateDateTime(
            textForParser,
            process.env.TZ || "America/Sao_Paulo"
          );

          if (found) {
           // Enriquecer o evento com Nome, Telefone e Motivo
const conv = getConversation(from);
const { name, phoneFormatted, reason } = extractPatientInfo({
  payload: p,
  phone: from,
  conversation: conv,
});

// Deixar bem evidente no título
const summary = `Consulta – ${name} – ${reason} – ${phoneFormatted}`;

// E também dentro da descrição, em linhas separadas
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
  attendees: [], // inclua e-mail somente com consentimento
  location: process.env.CLINIC_ADDRESS || "Clínica",
});

          } else {
            console.warn("Confirmação detectada, mas não consegui interpretar data/hora:", textForParser);
          }
        } catch (e) {
          console.error("Erro ao criar evento no Google Calendar:", e?.response?.data || e);
        }
      }
    }
    // ======== FIM DA REGRA DE CONFIRMAÇÃO ========

    // Memória + resposta ao paciente
    appendMessage(from, "user", userText);
    if (answer) {
      appendMessage(from, "assistant", answer);
      await sendWhatsAppText({ to: from, text: answer });
    }
  } catch (err) {
    console.error("ERR inbound:", err?.response?.data || err);
  }
}

// =====================
// Routes mapping
// =====================
app.post("/webhook/gupshup", handleInbound);
app.post("/healthz", handleInbound); // fallback/alias POST
app.post("/", handleInbound);        // fallback/alias

// =====================
// Start
// =====================
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
