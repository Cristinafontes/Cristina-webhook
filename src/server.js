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

// Segurança e estabilidade
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Memória curta para menu de cancelamento
const pendingCancel = new Map();
function setPendingCancel(from, options){ const expiresAt = Date.now() + 5*60*1000; pendingCancel.set(from,{expiresAt,options}); }
function getPendingCancel(from){ const it = pendingCancel.get(from); if(!it) return null; if(Date.now()>it.expiresAt){ pendingCancel.delete(from); return null; } return it; }

// Body parser compatível com Gupshup (sem logar conteúdo sensível)
app.use(async (req, res, next) => {
  if (req.method !== "POST") return next();
  try {
    const text = (await getRawBody(req)).toString("utf8");
    const ct = req.headers["content-type"] || "";
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
    req.body = {};
    return next();
  }
});

// ===== Handler principal =====
async function handleInbound(req, res) {
  // responde 200 cedo
  res.status(200).end();

  const eventType = req.body?.type || req.body?.event || null;
  if (eventType !== "message") return;

  const p = req.body?.payload || {};
  const from = p?.sender?.phone || p?.source || "";
  const text = (p?.payload?.text || p?.payload?.payload?.text || "").trim();

  // A) Cancelamento - resposta de menu
  const prev = getPendingCancel(from);
  if (prev && /^\d+$/.test(text)) {
    const idx = parseInt(text,10)-1;
    const choice = prev.options[idx];
    if (!choice) { await sendWhatsAppText(from,"Número inválido. Envie apenas o *número* da opção."); return; }
    await deleteCalendarEvent(choice.id);
    pendingCancel.delete(from);
    await sendWhatsAppText(from,`✅ Agendamento cancelado: ${choice.label}`);
    return;
  }

  // B) Cancelamento - nova intenção
  if (isCancelIntent(text)) {
    const parsed = parseCandidateDateTime(text);
    let events = [];

    if (parsed.found) {
      // janela ±120min e filtro por padrão do título
      events = await findCalendarEvents({ dateISO: parsed.startISO });
      const re = new RegExp(`^Consulta\\s+Dra\\.\\s*Jenifer\\s*\\[${parsed.dd}\\/${parsed.mm}\\/${parsed.yy}\\]`, "i");
      events = events.filter(ev => re.test(ev.summary || ""));
    } else {
      // sem data → listar próximos 30 dias filtrando pelo padrão
      events = await findCalendarEvents({});
      const re = /^Consulta\s+Dra\.\s*Jenifer\s*\[\d{2}\/\d{2}\/\d{2}\]/i;
      events = events.filter(ev => re.test(ev.summary || ""));
    }

    if (!events.length) { await sendWhatsAppText(from,"Não encontrei esse agendamento. Informe *data e horário* (ex.: 30/08 às 14:00)."); return; }
    if (events.length === 1) { await deleteCalendarEvent(events[0].id); await sendWhatsAppText(from,`✅ Agendamento cancelado: ${events[0].summary}`); return; }

    const options = events.slice(0,5).map(ev => ({ id: ev.id, label: ev.summary || "Consulta" }));
    setPendingCancel(from, options);
    const menu = options.map((o,i)=>`${i+1}. ${o.label}`).join("\n");
    await sendWhatsAppText(from,`Encontrei mais de um agendamento:\n\n${menu}\n\nResponda com o *número* da opção.`);
    return;
  }

  // C) Atendimento IA normal
  const userText = text;
  let answer;
  try {
    answer = await askCristina({ userText, userPhone: String(from) });
  } catch {
    // fallback sem expor segredos
    answer = "Oi! Posso marcar, remarcar ou cancelar sua consulta. Diga *data* e *horário* (ex.: 30/08 às 14:00).";
  }

  // D) Se a IA confirmou, cria o evento com o título padronizado
  const confirmRegex = /pronto!\s*sua\s+consulta\s+com\s+a\s+dra\.?\s*jenifer\s*est[aá]\s+agendada\s+para\s+o\s+dia\s+(\d{1,2})\/(\d{1,2})\/?(\d{2})?\s*,?\s*hor[áa]rio\s+(\d{1,2}:\d{2}|\d{1,2}h)/i;
  const m = answer && answer.match(confirmRegex);
  if (m) {
    try {
      const dd = String(m[1]).padStart(2,"0");
      const mm = String(m[2]).padStart(2,"0");
      const yy = String(m[3] || (new Date().getFullYear()%100)).padStart(2,"0");
      let hhmm = m[4];
      if (/^\d{1,2}h$/i.test(hhmm)) hhmm = hhmm.replace(/h$/i, ":00");

      const parsed = parseCandidateDateTime(`${dd}/${mm}/${yy} ${hhmm}`, process.env.TZ || "America/Sao_Paulo");
      if (parsed.found) {
        const prettyPhone = formatPhoneBR(from);
        const summary = `Consulta Dra. Jenifer[${parsed.dd}/${parsed.mm}/${parsed.yy}] - Paciente [Paciente] e telefone [${prettyPhone}]`;
        await createCalendarEvent({
          summary,
          description: `Agendado automaticamente pela secretária virtual.\nWhatsApp: ${from}`,
          startISO: parsed.startISO,
          endISO: parsed.endISO,
          attendees: [],
        });
      }
    } catch {}
  }

  // Envia a resposta
  if (!answer) answer = "Desculpe, não entendi. Pode repetir?";
  await sendWhatsAppText(from, answer);
}

// Utilitários
function formatPhoneBR(raw="") {
  const s = String(raw || "").replace(/\D/g, "");
  const local = s.startsWith("55") ? s.slice(2) : s;
  if (local.length === 11) return `(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`;
  return raw;
}

// Rotas
app.post("/webhook/gupshup", handleInbound);
app.post("/healthz", handleInbound);
app.post("/", handleInbound);

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
