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
import { createCalendarEvent,findPatientEvents,cancelCalendarEvent } from "./google.esm.js";
import { parseCandidateDateTime } from "./utils.esm.js";
import { isSlotBlockedOrBusy } from "./availability.esm.js";
import { listAvailableSlots } from "./slots.esm.js";

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
// Captura telefone de um texto livre (com ou sem "Telefone:"), aceitando formatos BR.
// Retorna string só com dígitos (com 55 se vier), ou null se não achar.

function extractPhoneFromText(text) {
  if (!text) return null;
  const t = String(text);

  // 1) Preferência: linhas rotuladas "Telefone:"
  const labeled = t.match(/telefone[^:]*:\s*([\s\S]+)/i);
  const target1 = labeled ? labeled[1] : t;

  // 2) Procura o primeiro bloco de dígitos que pareça telefone BR:
  //    Aceita "+55 (11) 91234-5678", "11912345678", "(11) 91234-5678", "11 91234 5678" etc.
  const m = target1.replace(/[^\d+]/g, " ")
                   .match(/(?:\+?55[\s\-\.]?)?\b(\d{2})[\s\-\.]?\d{4,5}[\s\-\.]?\d{4}\b/);
  if (!m) return null;

  // Normaliza para somente dígitos, preservando +55 se houver
  const onlyDigits = (m[0].match(/\d+/g) || []).join("");
  // Garante código do país se veio com +55, senão mantém como nacional
  const has55 = /^\+?55/.test(m[0]);
  return has55 ? ("55" + onlyDigits.replace(/^55/, "")) : onlyDigits;
}

// Lê um nome a partir de texto livre (com ou sem rótulo "Nome" / "Nome completo")
// Helpers para nome
function toTitleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b([a-zà-ÿ])([a-zà-ÿ'’\-]*)/g, (_, a, b) => a.toUpperCase() + b);
}

// Verifica se a string "parece" um nome de pessoa
function isLikelyName(s) {
  const words = String(s || "").trim().split(/\s+/);
  if (words.length < 2 || words.length > 6) return false;

  const particle = /^(da|de|do|das|dos|e|d['’]?)$/i;
  for (const w of words) {
    if (particle.test(w)) continue;
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*$/.test(w)) return false;
  }
  return true;
}
// Lê nome a partir de texto, rejeitando frases do tipo "quero presencial" etc.
function extractNameFromText(text) {
  if (!text) return null;
  const t = String(text);

  // 1) Preferência: rótulos "Nome:" / "Nome completo:"
  const labeled = t.match(/^\s*nome(?:\s+completo)?\s*[:\-]\s*([^\n]+)$/im);
  if (labeled && labeled[1]) {
    const v = labeled[1].trim();
    if (isLikelyName(v)) return toTitleCase(v);
  }

  // 2) Heurística por linhas, com stopwords para evitar modalidade/intenção
  const STOP = /\b(quero|prefiro|preferiria|presencial|telemedicina|confirmo|agendar|cancelar|remarcar|consulta|hor[aá]rio|modalidade|avaliac[aã]o|pré?-?anest|medicina|dor)\b/i;

  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/\d/.test(line)) continue; // ignora linhas com números (telefones/datas)
    if (STOP.test(line)) continue; // ignora frases operacionais
    if (/^(idade|telefone|motivo|dia)\b/i.test(line)) continue; // ignora rótulos de outros campos
    if (isLikelyName(line)) return toTitleCase(line);
  }
  return null;
}
// Extrai o motivo a partir de texto livre, MAS restringe às duas opções.
// Aceita variações com/sem acento, abreviações e respostas "1"/"2".
function extractReasonChoice(text) {
  if (!text) return null;
  const raw = String(text);
  const norm = raw
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase();

  // Mapeia respostas numéricas
  // Ex.: "1", "opcao 1", "1) medicina da dor"
  const isOne  = /\b(?:1|opcao\s*1|opção\s*1)\b/.test(norm);
  const isTwo  = /\b(?:2|opcao\s*2|opção\s*2)\b/.test(norm);
  if (isOne) return "Medicina da Dor";
  if (isTwo) return "Avaliação Pré-anestésica";

  // Palavras-chave para "Avaliação Pré-anestésica"
  if (
    /\b(pre[\s\-]?anest|avaliac\w*\s+pre[\s\-]?anest|preop|pre[\s\-]?operatori)/.test(norm) ||
    /\banestes(ia|ic[ao])\b/.test(norm)
  ) {
    return "Avaliação Pré-anestésica";
  }

  // Palavras-chave para "Medicina da Dor"
  if (
    /\bmedicina\s+da\s+dor\b/.test(norm) ||
    /\bdor(es)?\b/.test(norm) ||
    /\bneuropat|algia|lombar|cervical|ombro|joelho|coluna|cefale/.test(norm)
  ) {
    return "Medicina da Dor";
  }

  // Caso não detecte nada, retorna null para permitir outros fallbacks
  return null;
}

function extractPatientInfo({ payload, phone, conversation }) {
  const msgs = conversation?.messages || [];

// ====== NOME (prioriza texto digitado pelo paciente; fallback: nome do WhatsApp) ======
let name = null; // garante que 'name' exista no escopo

// Helpers locais
const toTitleCaseLocal = (str) =>
  String(str)
    .toLowerCase()
    .replace(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*)\b/g, (w) => w.charAt(0).toUpperCase() + w.slice(1))
    .replace(/\s+/g, " ")
    .trim();

const isLikelyNameLocal = (s) => {
  if (!s) return false;
  const v = String(s).trim();

  if ((v.match(/\d/g) || []).length >= 1) return false;
  if (v.length < 3 || v.length > 80) return false;
  if (!/^[A-Za-zÀ-ÿ'’. -]+$/.test(v)) return false;

  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return false;

  // bloqueia frases comuns que não são nome
  const BAD =
    /\b(agendar|agendo|agenda|agendamento|marcar|marque|consulta|consultar|presencial|telemedicina|teleconsulta|quero|querer|vou|prefer(ia|o)|confirm(ar|o)|avaliac[aã]o|pre[\s-]?anest|anestesia|idade|telefone|motivo|endere[cç]o|data|dia|ent[aã]o|às)\b/i;
  if (BAD.test(v)) return false;

  // dias da semana e meses
  const WEEKDAYS = /\b(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado)s?\b/i;
  const MONTHS   = /\b(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i;
  if (WEEKDAYS.test(v) || MONTHS.test(v)) return false;

  return true;
};

const extractNameLocal = (text) => {
  if (!text) return null;
  const t = String(text).trim();

  // 1) "Nome: Fulano" / "Nome completo: Fulana"
  const labeled = t.match(/^\s*nome(?:\s+completo)?\s*[:\-]\s*([^\n]+)$/im);
  if (labeled?.[1] && isLikelyNameLocal(labeled[1])) return toTitleCaseLocal(labeled[1]);

  // 2) "meu nome é Fulano", "me chamo Beltrano", "sou Ciclano"
  const sayMyName = t.match(/\b(?:meu\s+nome\s+é|me\s+chamo|sou)\s+([A-Za-zÀ-ÿ'’. -]{2,80})\b/i);
  if (sayMyName?.[1]) {
    const v = sayMyName[1].replace(/[.,;].*$/, "").trim();
    if (isLikelyNameLocal(v)) return toTitleCaseLocal(v);
  }

  // 3) Linha isolada com possível nome
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[A-Za-zÀ-ÿ'’. -]+$/.test(line) && isLikelyNameLocal(line)) {
      return toTitleCaseLocal(line);
    }
  }

  // 4) Nome embutido em frase (ex.: "agendar consulta com Jessica Oliveira dia 23/09")
  const candidates = [];
  const re = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]+){1,4})/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const cand = m[1].trim();
    if (isLikelyNameLocal(cand)) candidates.push(cand);
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
    return toTitleCaseLocal(candidates[0]);
  }

  return null;
};

// 1) Varre histórico do usuário
let nameFromUser = null;
if (Array.isArray(msgs)) {
  for (let i = msgs.length - 1; i >= 0 && !nameFromUser; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    nameFromUser = extractNameLocal(m.content);
  }
}

// 2) Se ainda não achou, tenta no payload atual
if (!nameFromUser) {
  const lastText = (
    payload?.payload?.text ||
    payload?.payload?.title ||
    payload?.payload?.postbackText ||
    payload?.text ||
    ""
  ) + "";
  nameFromUser = extractNameLocal(lastText);
}

// 3) Decide o nome final
if (nameFromUser && isLikelyNameLocal(nameFromUser)) {
  name = nameFromUser.trim();
} else {
  // fallback mais seguro
  const senderName = (payload?.sender?.name || "").toString().trim();
  name = isLikelyNameLocal(senderName) ? senderName : "Paciente (WhatsApp)";
}

// (opcional) log para ver nos Deploy Logs
console.log("[NAME PICKED]", name);
  // ====== TELEFONE (prioriza o informado pelo paciente) ======
  let phoneFromUser = null;
  for (let i = msgs.length - 1; i >= 0 && !phoneFromUser; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    phoneFromUser = extractPhoneFromText(m.content);
  }
  if (!phoneFromUser) {
    const lastText = (
      payload?.payload?.text ||
      payload?.payload?.title ||
      payload?.payload?.postbackText ||
      payload?.text ||
      ""
    ) + "";
    phoneFromUser = extractPhoneFromText(lastText);
  }
  const rawPhone = phoneFromUser || phone || payload?.sender?.phone || payload?.source;
  const phoneFormatted = formatBrazilPhone(rawPhone);

  // ====== MOTIVO (somente duas opções) ======
  let reason = null;

  // 1) Procura no histórico
  for (let i = msgs.length - 1; i >= 0 && !reason; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;

    const labeled = m.content?.match?.(/motivo\s*[:\-]\s*(.+)/i);
    if (labeled?.[1]) {
      reason = extractReasonChoice(labeled[1]);
      if (reason) break;
    }
    if (!reason) reason = extractReasonChoice(m.content);
  }

  // 2) Procura no payload atual
  if (!reason) {
    const lastText = (
      payload?.payload?.text ||
      payload?.payload?.title ||
      payload?.payload?.postbackText ||
      payload?.text ||
      ""
    ) + "";
    const labeled = lastText.match(/motivo\s*[:\-]\s*(.+)/i);
    if (labeled?.[1]) {
      reason = extractReasonChoice(labeled[1]);
    }
    if (!reason) reason = extractReasonChoice(lastText);
  }

  // 3) Fallback garantido
  if (!reason) reason = "Medicina da Dor";
  // ====== MODALIDADE (3=Presencial, 4=Telemedicina; aceita texto; prioriza o mais recente) ======
let modality = null;

// 1) Coleta texto de qualquer formato (payload e histórico)
const pickTexts = (obj) => {
  const out = [];
  const push = (v) => { if (v && typeof v === "string") out.push(v); };

  if (!obj) return out;

  // se obj já é string
  if (typeof obj === "string") { out.push(obj); return out; }

  // chaves comuns
  push(obj.text);
  push(obj.content);
  push(obj.title);
  push(obj.postbackText);

  // estruturas aninhadas comuns em bots
  if (obj.message) push(obj.message.text);
  if (obj.payload) {
    push(obj.payload.text);
    push(obj.payload.title);
    push(obj.payload.postbackText);
    if (obj.payload.payload) {
      push(obj.payload.payload.text);
      push(obj.payload.payload.title);
      push(obj.payload.payload.postbackText);
    }
    if (obj.payload.message) push(obj.payload.message.text);
  }

  return out.filter(Boolean);
};

// 2) Normaliza -> decide modalidade a partir de um texto
const extractModalityChoice = (text) => {
  if (!text) return null;
  const t = String(text).toLowerCase();

  // NÚMEROS (se o paciente responder só o número)
  if (/\b4\b/.test(t)) return "Telemedicina";
  if (/\b3\b/.test(t)) return "Presencial";

  // PALAVRAS/EXPRESSÕES
  if (/\btele\s*medicina\b|\bteleconsulta\b|\btele\s*atendimento\b|\bon\s?-?line\b|\bvirtual\b|\bvídeo?\s*chamada\b|\bvideo?\s*chamada\b|\bremot[oa]\b/.test(t)) {
    return "Telemedicina";
  }
  if (/\bpresencial\b|\bconsult[óo]rio\b/.test(t)) {
    return "Presencial";
  }
  return null;
};

// 3) Monta uma lista de textos do mais recente para o mais antigo
const texts = [];

// a) payload atual (última mensagem do usuário)
pickTexts(payload).forEach((s) => texts.push(s));

// b) histórico correto: usar conversation.messages (quando existir)
const histMsgs = Array.isArray(conversation?.messages) ? conversation.messages : [];
for (let i = histMsgs.length - 1; i >= 0; i--) {
  // Não precisamos filtrar por role aqui, pois algumas integrações não incluem 'role'
  pickTexts(histMsgs[i]).forEach((s) => texts.push(s));
}

// 4) Decide: percorre do mais recente para o mais antigo
for (const t of texts) {
  // dentro de cada texto, se houver os dois termos, TELE ganha
  if (/\b4\b|\btele\s*medicina\b|\bteleconsulta\b|\btele\s*atendimento\b|\bon\s?-?line\b|\bvirtual\b|\bvídeo?\s*chamada\b|\bvideo?\s*chamada\b|\bremot[oa]\b/i.test(t)) {
    modality = "Telemedicina";
    break;
  }
  if (/\b3\b|\bpresencial\b|\bconsult[óo]rio\b/i.test(t)) {
    modality = "Presencial";
    break;
  }
}

// 5) Fallback (se nada detectado)
if (!modality) modality = "Presencial";

// Log de diagnóstico
console.log("[MODALITY PICKED]", modality, "| sample(lastText)=", (texts[0] || "").slice(0, 120));

  return { name, phoneFormatted, reason, modality };
}


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

// === INTENÇÃO DE CANCELAMENTO / REAGENDAMENTO ===
// (entra em modo "cancel" ou "reschedule"; pede só telefone + nome, busca o evento e prossegue)
{
  const convMem = ensureConversation(from);

  // detectar entrada no modo
  if (/\b(reagend|remarc|cancel)\w*/i.test(userText)) {
    convMem.mode = /\b(reagend|remarc)\w*/i.test(userText) ? "reschedule" : "cancel";
    convMem.cancelData = { phone: null, name: null };
    convMem.pickEventMode = null;
  }

  if (convMem.mode === "cancel" || convMem.mode === "reschedule") {
    try {
      const normPhone = (t) => String(t || "").replace(/[^\d]/g, "");
      const guessPhone = (t) => {
        const only = normPhone(t);
        return (only.length >= 10 && only.length <= 13) ? only : null;
      };

      const data = (convMem.cancelData ||= { phone: null, name: null });

      // captura telefone desta mensagem, se vier
      if (!data.phone) {
        const pFound = guessPhone(userText);
        if (pFound) data.phone = pFound;
      }
      // tenta capturar nome (filtra palavras comuns)
      if (!data.name) {
        const maybeName = (userText || "")
          .replace(/#\w+:[^\s]+/g, "")
          .replace(/[0-9\-\+\(\)]/g, "")
          .replace(/\b(cancel(ar|amento)|reagend(ar|amento)|remarc(ar|ação)|consulta|telefone|celular)\b/gi, "")
          .trim();
        if (/\p{L}/u.test(maybeName) && maybeName.length >= 3) data.name = maybeName;
      }

      if (!data.phone) {
        await sendWhatsAppText({ to: from, text: "Para **cancelar/reagendar**, me informe o **telefone do paciente** (apenas números)." });
        return;
      }
      if (!data.name) {
        await sendWhatsAppText({ to: from, text: "Perfeito. Agora me diga o **nome completo do paciente**." });
        return;
      }

      // temos telefone + nome -> busca eventos
      const matches = await findPatientEvents({
        calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
        phone: data.phone,
        name: data.name,
        daysBack: 120,
        daysAhead: 365
      });

      if (!matches.length) {
        await sendWhatsAppText({
          to: from,
          text: "Não localizei nenhum agendamento com esse **telefone/nome**. Pode me informar uma **data aproximada** (ex.: 24/09) para eu buscar novamente?"
        });
        return;
      }

      if (matches.length === 1) {
        const ev = matches[0];
        if (convMem.mode === "cancel") {
          await cancelCalendarEvent({ calendarId: process.env.GOOGLE_CALENDAR_ID || "primary", eventId: ev.id });
          await sendWhatsAppText({ to: from, text: `✅ Cancelado: ${ev.dayLabel} ${ev.timeLabel} — ${ev.summary}` });
          convMem.mode = null;
          convMem.cancelData = null;
          return;
        } else {
          // reagendar: cancela e ancora sugestões perto da data original
          await cancelCalendarEvent({ calendarId: process.env.GOOGLE_CALENDAR_ID || "primary", eventId: ev.id });
          convMem.mode = null;
          convMem.cancelData = null;
          convMem.contextDate = ev.startISO?.slice(0,10);
          await sendWhatsAppText({
            to: from,
            text: "Cancelamento concluído. Vamos **remarcar** agora. Informe a **nova data e horário** (ex.: 30/09 14:00) ou diga **'próximos horários'**."
          });
          return;
        }
      }

      // vários resultados -> lista para escolher com "opção N"
      convMem.pickEventMode = convMem.mode; // "cancel" ou "reschedule"
      convMem.lastSlots = matches.map(m => ({
        dayLabel: m.dayLabel,
        label: m.timeLabel,
        startISO: m.startISO,
        meta: { eventId: m.id, summary: m.summary }
      }));

      const linhas = matches.map((m, i) => `${i + 1}) ${m.dayLabel} ${m.timeLabel} — ${m.summary}`);
      const msg = "Encontrei mais de um agendamento. Por favor, responda com *opção N* (ex.: \"opção 2\"):\n" + linhas.join("\n");
      await sendWhatsAppText({ to: from, text: msg });
      return;

    } catch (err) {
      console.error("[cancel/reschedule] erro:", err?.response?.data || err);
      await sendWhatsAppText({ to: from, text: "Tive um problema ao procurar o agendamento. Pode tentar novamente em instantes?" });
      return;
    }
  }
}
// === ATALHO: "opção N" (somente fora do modo cancelamento) ===
try {
  const raw = String(userText || "");
  const convMem = ensureConversation(from);

  // PRIORIDADE: escolhendo qual evento cancelar/reagendar
  if (convMem.pickEventMode && Array.isArray(convMem.lastSlots) && convMem.lastSlots.length) {
    const pickedNum = _optionFromText(raw);
    if (pickedNum) {
      const idx = pickedNum - 1;
      const item = convMem.lastSlots[idx];
      if (!item?.meta?.eventId) {
        await sendWhatsAppText({ to: from, text: `Não encontrei a **opção ${pickedNum}** nessa lista. Pode tentar outro número?` });
        return;
      }
      const evId = item.meta.eventId;

      if (convMem.pickEventMode === "cancel") {
        await cancelCalendarEvent({ calendarId: process.env.GOOGLE_CALENDAR_ID || "primary", eventId: evId });
        await sendWhatsAppText({ to: from, text: `✅ Cancelado: ${item.dayLabel} ${item.label} — ${item.meta.summary || ""}` });
        convMem.pickEventMode = null;
        convMem.lastSlots = null;
        convMem.mode = null;
        return;
      } else {
        await cancelCalendarEvent({ calendarId: process.env.GOOGLE_CALENDAR_ID || "primary", eventId: evId });
        convMem.pickEventMode = null;
        convMem.lastSlots = null;
        convMem.mode = null;
        convMem.contextDate = item.startISO?.slice(0,10);
        await sendWhatsAppText({
          to: from,
          text: "Cancelado. Vamos **remarcar**: informe a **nova data e horário** (ex.: 30/09 14:00) ou diga **'próximos horários'**."
        });
        return;
      }
    }
    // se não veio número, segue para outros atalhos
  }

  // (resto do atalho para “opção N” da listagem de horários normais)
  const picked = _optionFromText(raw);
  const slots = Array.isArray(convMem.lastSlots) ? convMem.lastSlots : [];

  if (picked && slots.length) {
    const idx = picked - 1;
    const chosen = slots[idx];

    if (!chosen) {
      const msg = `Não encontrei a **opção ${picked}** nesta lista. Você pode escolher outro número ou digitar *data e horário* (ex.: "24/09 14:00").`;
      appendMessage(from, "assistant", msg);
      await sendWhatsAppText({ to: from, text: msg });
      return;
    }

    // usa o startISO do slot para montar o comando direto
    if (chosen.startISO) {
      const dt = new Date(chosen.startISO);
      const dd = String(dt.getDate()).padStart(2, "0");
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const hh = String(dt.getHours()).padStart(2, "0");
      const mi = String(dt.getMinutes()).padStart(2, "0");
      userText = `Quero agendar nesse horário: ${dd}/${mm} ${hh}:${mi}`;
    } else {
      // fallback por label
      const dateByLabel = (chosen.dayLabel || "").match(/(\d{2})\/(\d{2})/);
      const timeByLabel = (chosen.label || "").match(/(\d{2}):(\d{2})/);
      if (dateByLabel && timeByLabel) {
        userText = `Quero agendar nesse horário: ${dateByLabel[1]}/${dateByLabel[2]} ${timeByLabel[1]}:${timeByLabel[2]}`;
      }
    }
    // deixa seguir para o fluxo normal de criação do evento
  }
} catch (e) {
  console.error("[atalho-opcaoN] erro:", e?.message || e);
}
    safeLog("INBOUND", req.body);

// === PEDIDO DE DATA ESPECÍFICA (ex.: "tem dia 24/09?", "quero dia 24/09") ===
if ((getConversation(from)?.mode || null) !== "cancel") {
  try {
    const raw = String(userText || "");
    // dd/mm ou dd/mm/aa(aa) – aceita "dia 24/09", "24-09", etc.
    const mDate = raw.match(/(?:\bdia\s*)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);

    // horas opcionais (ex.: 14h, 14:00, 9:30)
    const mTime = raw.match(/\b(\d{1,2})(?:[:h](\d{2}))\b/i);

    if (mDate) {
      const tz = process.env.TZ || "America/Sao_Paulo";
      const dd = String(mDate[1]).padStart(2, "0");
      const mm = String(mDate[2]).padStart(2, "0");
      let yyyy;
      if (mDate[3]) {
        const yy = String(mDate[3]);
        yyyy = yy.length === 2 ? (2000 + Number(yy)) : Number(yy);
      } else {
        yyyy = new Date().getFullYear();
      }

      // Se o paciente já deu hora junto (ex.: "24/09 14:00"), vira intenção direta
      if (mTime) {
        const hh = String(mTime[1]).padStart(2, "0");
        const mi = String(mTime[2] || "00").padStart(2, "0");
        userText = `Quero agendar nesse horário: ${dd}/${mm} ${hh}:${mi}`;
      } else {
        // Só a DATA -> listar horários desse dia
        const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        const slots = await listAvailableSlots({
          fromISO: dayStart.toISOString(),
          days: 1,
          limit: 10
        });

        const convMem = ensureConversation(from);
        convMem.lastSlots = slots;
        convMem.updatedAt = Date.now();

        const { name } = extractPatientInfo({ payload: p, phone: from, conversation: getConversation(from) });

        if (!slots.length) {
          const msg =
            `Olá${name ? `, ${name}` : ""}! Para **${dd}/${mm}** não encontrei horários livres.\n` +
            `Posso te enviar alternativas próximas dessa data ou procurar outra data que você prefira.`;
          appendMessage(from, "assistant", msg);
          await sendWhatsAppText({ to: from, text: msg });
        } else {
          const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`);
          const msg =
            `Claro, escolha uma dentre as opções para **${dd}/${mm}** que seguem abaixo:\n` +
            linhas.join("\n") +
            `\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").`;
          appendMessage(from, "assistant", msg);
          await sendWhatsAppText({ to: from, text: msg });
        }
        return; // já respondemos com as opções do dia solicitado
      }
    }
  } catch (e) {
    console.error("[future-date] erro:", e?.message || e);
  }
}

    const trimmed = (userText || "").trim().toLowerCase();
  
    if (["reset", "reiniciar", "reiniciar conversa", "novo atendimento"].includes(trimmed)) {
  resetConversation(from);
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

    // === SE A IA MENCIONAR QUE VAI ENVIAR HORÁRIOS, ANEXA A LISTA GERADA DO CALENDÁRIO ===
let finalAnswer = answer;
try {
  const shouldList = /vou te enviar os hor[aá]rios livres/i.test(answer || "");
    const modeNow = getConversation(from)?.mode || null;
if (shouldList && modeNow !== "cancel") {
    const slots = await listAvailableSlots({
      fromISO: new Date().toISOString(),
      days: 7,
      limit: 10
    });

    const { name } = extractPatientInfo({ payload: p, phone: from, conversation: getConversation(from) });

    if (!slots.length) {
      finalAnswer =
        `Obrigado pelo contato${name ? `, ${name}` : ""}! ` +
        `No momento não encontrei horários livres nos próximos dias.\n` +
        `Se preferir, me diga uma **data específica** (ex.: "24/09") que eu verifico para você.`;
    } else {
      const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`);
finalAnswer =
  "Claro, escolha uma dentre as opções mais próximas que seguem abaixo:\n" +
  linhas.join("\n") +
  "\n\nVocê pode responder com **opção N** (ex.: \"opção 3\") ou digitar **data e horário** (ex.: \"24/09 14:00\").";

      
      const convMem = ensureConversation(from);
      convMem.lastSlots = slots;
      convMem.updatedAt = Date.now();
    }
  }
} catch (e) {
  console.error("[slots-append] erro:", e?.message || e);
}
    
    // ======== DISPARO DE CANCELAMENTO (formato EXATO) ========
    // "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia dd/mm/aa HH:MM"
    try {
     const cancelRegex =
       /^Pronto!\s*Sua consulta com a Dra\.?\s*Jenifer está cancelada para o dia\s+(\d{2})\/(\d{2})(?:\/(\d{2}))?\s+(\d{1,2}:\d{2})\.?$/i;
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
            // Enriquecer o evento com Nome, Telefone, Motivo e Modalidade
const conv = getConversation(from);
const { name, phoneFormatted, reason, modality } = extractPatientInfo({
  payload: p,
  phone: from,
  conversation: conv,
});

// Título com modalidade
const summary = `Consulta (${modality}) — ${name} — ${reason} — ${phoneFormatted}`;

// Descrição com modalidade
const description = [
  `Paciente: ${name}`,
  `Telefone: ${phoneFormatted}`,
  `Motivo: ${reason}`,
  `Modalidade: ${modality}`,
  `Origem: WhatsApp (Cristina)`,
].join("\n");

// Opcional: também refletir no "Local"
const location =
  modality === "Telemedicina"
    ? "Telemedicina (link será enviado)"
    : (process.env.CLINIC_ADDRESS || "Clínica");
            
            // === CHECA CONFLITO NO CALENDÁRIO ANTES DE CRIAR ===
const { busy, conflicts } = await isSlotBlockedOrBusy({ startISO, endISO });
if (busy) {
  let msg = "Esse horário acabou de ficar indisponível.";
  if (conflicts?.length) {
    const tz = process.env.TZ || "America/Sao_Paulo";
    const lines = conflicts.map(c => {
      const when = new Date(c.start);
      const lbl = when.toLocaleString("pt-BR", { timeZone: tz });
      return `• ${lbl} — ${c.summary || "Compromisso"}`;
    });
    msg += "\n\nConflitos encontrados:\n" + lines.join("\n");
  }
  const alternativas = await listAvailableSlots({
  fromISO: startISO,
  days: 3,   // só os próximos 3 dias como alternativa
  limit: 5
});

  if (alternativas?.length) {
    msg += "\n\nPosso te oferecer estes horários:\n" +
      alternativas.map((s,i)=> `${i+1}) ${s.dayLabel} ${s.label}`).join("\n");
    // guarda na memória para permitir "opção N"
    const convMem = ensureConversation(from);
    convMem.lastSlots = alternativas;
    convMem.updatedAt = Date.now();
  } else {
    msg += "\n\nNos próximos dias não há janelas livres. Posso procurar mais adiante.";
  }
  await sendWhatsAppText({ to: from, text: msg });
  return; // não cria evento, sai daqui
}
// --- [A] ANTES do createCalendarEvent: anexa tags e props privadas ---
const _normPhone = (p) => String(p || "").replace(/[^\d]/g, "");
const { name: patientName } = extractPatientInfo({
  payload: p,
  phone: from,
  conversation: getConversation(from)
});
const patientPhone = _normPhone(from);

// tags no description (permite achar via busca 'q')
const metaTags = `#cristina #patient_phone:${patientPhone} #patient_name:${patientName || ""}`.trim();
description = [description || "", metaTags].filter(Boolean).join("\n");

// propriedades privadas (opcional, mas recomendado)
const extendedProperties = {
  private: {
    created_by: "cristina",
    patient_phone: patientPhone,
    patient_name: String(patientName || "")
  }
};

// --- chamada ajustada ---
await createCalendarEvent({
  summary,
  description,
  startISO,
  endISO,
  location,
  calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
  extendedProperties,           // << NOVO
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

if (finalAnswer) {
  // (opcional) filtros de linguagem
  finalAnswer = finalAnswer
    .replace(/vou verificar a disponibilidade.*?(confirmo já)?/gi, "")
    .replace(/vou verificar.*?(disponibilidade|agenda)?/gi, "")
    .replace(/deixe[- ]?me checar.*?/gi, "")
    .replace(/vou confirmar.*?/gi, "")
    .replace(/vou conferir.*?/gi, "")
    .replace(/já te confirmo.*?/gi, "")
    .trim();

  appendMessage(from, "assistant", finalAnswer);
  await sendWhatsAppText({ to: from, text: finalAnswer });
}

// <-- fecha o try global do handleInbound
} catch (err) {
  console.error("ERR inbound:", err?.response?.data || err);
}

// <-- fecha a função handleInbound
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
