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
import { createCalendarEvent, findPatientEvents, cancelCalendarEvent } from "./google.esm.js";
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
// Identidade por conversa (nome/telefone confiáveis e estáveis)
function getIdentity(phone) {
  const c = getConversation(phone);
  return (c && c.identity) ? c.identity : { name: "", phone: "" };
}
function setIdentity(phone, partial) {
  const c = ensureConversation(phone);
  c.identity = { ...(c.identity || { name: "", phone: "" }), ...(partial || {}) };
  c.updatedAt = nowMs();
}

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
// Normaliza para somente dígitos (mantém DDI 55 se vier)
function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }

// Retorna "55DDD9XXXXXXXX" ou "DDDnXXXXXXX" (sem símbolos)
function normalizePhoneForLookup(raw) {
  const d = onlyDigits(raw);
  if (!d) return "";
  if (d.length === 13 && d.startsWith("55")) return d; // 55 + 2(DDD) + 9 + 8
  if (d.length === 12 && d.startsWith("55")) return d; // 55 + 2(DDD) + 8
  if (d.length === 11 || d.length === 10) return d;    // nacional
  if (d.length > 11 && !d.startsWith("55")) return "55" + d; // força DDI
  return d;
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
  const convKey =
  (payload?.sender?.phone || payload?.source || "").toString().trim(); 
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
// Confirmações curtas NÃO são nome
if (/^(correto|correta|certo|isso|sim|ok|perfeito|confirmo|confirmada|confirmado)$/i.test(t)) {
  return null;
}

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
    const parts = line.split(/\s+/).filter(Boolean);
if (parts.length >= 2 && /^[A-Za-zÀ-ÿ'’. -]+$/.test(line) && isLikelyNameLocal(line)) {
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
const prevId = getIdentity(convKey);

// 3) Decide o nome final (preferência: user -> identidade fixa -> sender)
if (nameFromUser && isLikelyNameLocal(nameFromUser)) {
  name = nameFromUser.trim();
} else if (prevId.name) {
  name = prevId.name;
} else {
  const senderName = (payload?.sender?.name || "").toString().trim();
  name = isLikelyNameLocal(senderName) ? senderName : "Paciente (WhatsApp)";
}
// Se o nome é "bom" (2+ palavras) e não é o placeholder, fixa na identidade
if (name && name.split(/\s+/).filter(Boolean).length >= 2 && name !== "Paciente (WhatsApp)") {
  setIdentity(convKey, { name });
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
  const rawPhone =
  phoneFromUser ||
  prevId?.phone ||           // ← usa o telefone já salvo
  phone ||
  payload?.sender?.phone ||
  payload?.source;

  const phoneFormatted = formatBrazilPhone(rawPhone);
// 🔒 Fixa telefone "bom" na identidade da conversa
const digits = (phoneFormatted || "").replace(/\D/g, "");

// Só grava se tiver pelo menos 10 dígitos (fixo) ou 11 (celular)
if (digits.length >= 10) {
  // Se já existe um telefone salvo, só substitui se o novo for "melhor" (mais dígitos)
  const current = (prevId?.phone || "").replace(/\D/g, "");
  if (!current || digits.length > current.length) {
    setIdentity(convKey, { phone: phoneFormatted });
  }
}

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

    const trimmed = (userText || "").trim().toLowerCase();
  
    if (["reset", "reiniciar", "reiniciar conversa", "novo atendimento"].includes(trimmed)) {
  resetConversation(from);
  return;
}
    // === INTENÇÃO: RECUPERAR/LEMBRAR AGENDAMENTO (modo "retrieve") ===
{
  const convMem = ensureConversation(from);
  const raw = (userText || "").toLowerCase();

  // Heurística simples e robusta: pede "consulta/agendamento" + um verbo de consulta
  const wantRetrieve =
    /\b(consulta|agendamento)\b/.test(raw) &&
    /\b(quando|qual|horario|horário|que\s*horas|esqueci|lembrar|confirmar)\b/.test(raw);

  if (wantRetrieve) {
    convMem.mode = "retrieve";
    convMem.retrieveCtx = { phone: "", name: "", list: null, chosen: null };
    convMem.updatedAt = Date.now();

    // Tenta já pegar dados desta própria mensagem
    const maybePhone = extractPhoneFromText(userText);
    if (maybePhone) convMem.retrieveCtx.phone = normalizePhoneForLookup(maybePhone);

    const maybeName = (extractNameFromText?.(userText) || "").trim();
    if (maybeName) convMem.retrieveCtx.name = maybeName;

    // Se ainda não tenho identidade mínima, peço e encerro este turno
    if (!convMem.retrieveCtx.phone && !convMem.retrieveCtx.name) {
      await sendWhatsAppText({
        to: from,
        text:
          "Certo! Para localizar com segurança, me envie **Telefone** (DDD + número) e/ou **Nome completo**.\n" +
          "Assim eu te informo **dia e horário** certinho."
      });
      return;
    }
    // Se já tenho algum dado, o bloco do "modo retrieve" (abaixo) continua o fluxo.
  }
}

// === INTENÇÃO DE CANCELAMENTO / REAGENDAMENTO ===
{
  const convMem = ensureConversation(from);

  // Boas variações de "remarcar"
  const rescheduleIntent = /\b(reagend(ar|amento)|remarc(ar|ação)|mudar\s*(o\s*)?hor[áa]rio|trocar\s*(o\s*)?hor[áa]rio|adiar)\b/i;
  // Boas variações de "cancelar"
  const cancelIntent     = /\b(cancel(ar|amento)|desmarcar|quero\s*cancelar)\b/i;

  if (rescheduleIntent.test(userText)) {
    convMem.mode = "cancel";
    convMem.after = "schedule";      // <- sinaliza que após cancelar vamos agendar
    convMem.cancelCtx = { phone: "", name: "", dateISO: null, timeHHMM: null, chosenEvent: null };
    convMem.updatedAt = Date.now();

    await sendWhatsAppText({
  to: from,
  text:
    "Vamos **remarcar**. Primeiro, preciso encontrar seu agendamento atual.\n" +
    "Por favor, me envie **Telefone** (DDD + número) **e/ou** **Nome completo**.\n" +
    "Se você souber, **data e horário** também me ajudam a localizar rapidinho (ex.: 26/09 09:00)."
});
return;
  }

  if (cancelIntent.test(userText)) {
    convMem.mode = "cancel";
    convMem.after = null;            // cancelamento simples
    convMem.cancelCtx = { phone: "", name: "", dateISO: null, timeHHMM: null, chosenEvent: null };
    convMem.updatedAt = Date.now();

    
await sendWhatsAppText({
  to: from,
  text:
    "Certo, vamos **cancelar**. Para eu localizar seu agendamento, me envie **Telefone** (DDD + número) **e/ou** **Nome completo**.\n" +
    "Se você souber, **data e horário** também me ajudam a localizar (ex.: 26/09 09:00)."
});
return;
  }
}

// === MODO CANCELAMENTO: coletar dados (telefone/nome/data) e cancelar com base em 1+ campos ===
{
  const convMem = getConversation(from);
  if (convMem?.mode === "cancel") {
    const ctx = convMem.cancelCtx || (convMem.cancelCtx = { phone: "", name: "", dateISO: null, timeHHMM: null, chosenEvent: null });
    // Se estamos aguardando confirmação do cancelamento:
if (ctx.awaitingConfirm) {
  const yes = /\b(sim|pode|confirmo|confirmar|ok|isso|pode cancelar)\b/i.test(userText || "");
  const no  = /\b(n[aã]o|negativo|melhor n[aã]o|cancelar n[aã]o)\b/i.test(userText || "");

  if (yes && ctx.chosenEvent) {
  // confirmou: destrava confirmação e marca flag permanente
  ctx.awaitingConfirm = false;
  ctx.confirmed = true;
  convMem.updatedAt = Date.now();
  // segue o fluxo adiante até o bloco "Cancelar no Google"
} else if (no) {
    // não quer mais cancelar → volta para IA ajudar
    ctx.awaitingConfirm = false;
    convMem.mode = null;
    convMem.after = null;

    await sendWhatsAppText({
      to: from,
      text:
        "Sem problema! Posso **manter** seu agendamento, **tirar dúvidas** sobre a consulta, ou, se preferir, posso **remarcar** para outro dia/horário. Como posso te ajudar agora?"
    });
    return;
  } else {
    // não entendi; reapresenta o pedido, sem travar
    await sendWhatsAppText({
      to: from,
      text: "Só para confirmar: deseja mesmo **cancelar** esse horário? Responda **sim** ou **não**."
    });
    return;
  }
}

// Se paciente respondeu "1", "2", etc. e já existe lista salva → processa aqui
const pickM = (userText || "").match(/^\s*(\d{1,2})\s*$/);
if (pickM && Array.isArray(convMem.cancelCtx?.matchList) && convMem.cancelCtx.matchList.length) {
  const idx = Number(pickM[1]) - 1;
  const chosen = convMem.cancelCtx.matchList[idx];
  if (chosen) {
    ctx.chosenEvent = chosen;
  } else {
    await sendWhatsAppText({ to: from, text: "Número inválido. Responda com 1, 2, 3 conforme a lista." });
    return;
  }
}

    // 1) Tentar extrair telefone e nome do texto livre
    // telefone
    const maybePhone = extractPhoneFromText(userText);
    if (maybePhone) ctx.phone = normalizePhoneForLookup(maybePhone);

    // nome (reaproveita seu extrator robusto)
    const candidateName = (extractNameFromText?.(userText) || "").trim();
    if (candidateName) ctx.name = candidateName;

    // 2) Tentar extrair data/hora (aceita "26/09", "26/09 09:00", "26-09 9h")
    const mDate = userText.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    const mTime = userText.match(/\b(\d{1,2})(?::|h)(\d{2})\b/);
    if (mDate) {
      const dd = String(mDate[1]).padStart(2, "0");
      const mm = String(mDate[2]).padStart(2, "0");
      const yyyyFull = mDate[3] ? (String(mDate[3]).length === 2 ? 2000 + Number(mDate[3]) : Number(mDate[3])) : new Date().getFullYear();
      ctx.dateISO = `${yyyyFull}-${mm}-${dd}T00:00:00`;
    }
    if (mTime) {
      const hh = String(mTime[1]).padStart(2, "0");
      const mi = String(mTime[2]).padStart(2, "0");
      ctx.timeHHMM = `${hh}:${mi}`;
    }

    // 3) GATE: só seguimos se tiver TELEFONE ou NOME; data/hora sozinha não basta
if (!ctx.phone && !ctx.name) {
  // o paciente mandou apenas data/hora ou nada útil → peça identidade
  await sendWhatsAppText({
    to: from,
    text:
      "Para localizar com segurança, me envie **Telefone** (DDD + número) **e/ou** **Nome completo**.\n" +
      "Se souber, **data e horário** também me ajudam (ex.: 26/09 09:00)."
  });
  return;
}

    // 4) Buscar eventos: se tiver telefone/nome uso o Google; se tiver data/hora, filtro também pela data
    // Não fazemos busca se não houver identidade
if (!ctx.phone && !ctx.name) {
  await sendWhatsAppText({
    to: from,
    text:
      "Preciso de **Telefone** (DDD + número) **e/ou** **Nome completo** para localizar seu agendamento.\n" +
      "Se tiver, a **data e horário** também ajudam."
  });
  return;
}
    let matches = [];
    try {
      const phoneForLookup = ctx.phone || (normalizePhoneForLookup(conversations.get(from)?.lastKnownPhone) || "");
      const nameForLookup  = ctx.name  || "";
      const rawEvents = await findPatientEvents({
        phone: phoneForLookup,
        name:  nameForLookup,
        daysBack: 180,
        daysAhead: 365
      });

      // Filtro por data/hora se informado
      if (ctx.dateISO) {
        const dayStart = new Date(ctx.dateISO);
        const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        matches = rawEvents.filter(ev => {
          const dt = ev.startISO ? new Date(ev.startISO) : null;
          if (!dt) return false;
          if (dt < dayStart || dt >= dayEnd) return false;
          if (ctx.timeHHMM) {
            const hh = String(dt.getHours()).padStart(2, "0");
            const mi = String(dt.getMinutes()).padStart(2, "0");
            const hhmm = `${hh}:${mi}`;
            // tolerância de 15 min: aproxima por string exata OU arredonda próximo
            if (hhmm !== ctx.timeHHMM) {
              const diff = Math.abs(dt.getTime() - new Date(`${dayStart.toISOString().slice(0,10)}T${ctx.timeHHMM}:00`).getTime());
              if (diff > 15 * 60 * 1000) return false;
            }
          }
          return true;
        });
      } else {
        matches = rawEvents;
      }
    } catch (e) {
      console.error("[cancel-lookup] erro:", e?.message || e);
      matches = [];
    }

    // 5) Se nada encontrado, peça o que falta (sem travar)
    if (!matches.length) {
      const faltantes = [];
      if (!ctx.phone) faltantes.push("Telefone");
      if (!ctx.name)  faltantes.push("Nome");
      const pedacos =
        faltantes.length
          ? `Tente me enviar ${faltantes.join(" e ")} (pode ser só um deles)`
          : "Se puder, me confirme a **data** (ex.: 26/09) e o **horário** (ex.: 09:00) do agendamento";
      await sendWhatsAppText({
        to: from,
        text:
          "Não encontrei seu agendamento com as informações atuais.\n" +
          pedacos + " para eu localizar certinho."
      });
      return;
    }

    // 6) Se múltiplos, lista para escolha
    if (matches.length > 1 && !ctx.chosenEvent) {
      const linhas = matches.map((ev, i) => `${i + 1}) ${ev.dayLabel} ${ev.timeLabel} — ${ev.summary || "Consulta"}`);
      await sendWhatsAppText({
        to: from,
        text:
          "Encontrei mais de um agendamento. Escolha **1**, **2**, **3**...\n" +
          linhas.join("\n")
      });
      convMem.cancelCtx.matchList = matches;
      convMem.updatedAt = Date.now();
      return;
    }

    // 7) Se ainda não fixou um evento (mas só há 1), pega o único
    if (!ctx.chosenEvent && matches.length === 1) {
      ctx.chosenEvent = matches[0];
    }

    if (!ctx.chosenEvent) {
      // ainda não escolheu corretamente
      return;
    }
// 8) Confirma ANTES de cancelar (novo passo)
if (ctx.chosenEvent && !ctx.awaitingConfirm && !ctx.confirmed) {
  const who = (ctx.name && ctx.name !== "Paciente (WhatsApp)") ? `, ${ctx.name}` : "";
  const dd = ctx.chosenEvent.dayLabel;
  const hhmm = ctx.chosenEvent.timeLabel;

  await sendWhatsAppText({
    to: from,
    text:
      `Pronto${who}, encontrei sua consulta em **${dd}**, às **${hhmm}**.\n` +
      `Posso proceder com o cancelamento? Responda sim ou não.`
  });

  // marca que estamos aguardando confirmação
  ctx.awaitingConfirm = true;
  convMem.updatedAt = Date.now();
  return;
}

    // 8) Cancelar no Google (executa somente após confirmação "sim")
if (!ctx.confirmed) {
  // ainda não confirmou; não executa cancelamento
  return;
}
try {
  await cancelCalendarEvent({ eventId: ctx.chosenEvent.id });
} catch (e) {

  console.error("[cancel-google] erro:", e?.message || e);
  await sendWhatsAppText({
    to: from,
    text: "Tive um erro ao cancelar no calendário. Pode me enviar novamente as informações ou digitar 'reset' para recomeçar?"
  });
  return;
}

    // Mensagem padrão compatível com seu fluxo antigo (mantida)
    const dd = ctx.chosenEvent.dayLabel;
    const hhmm = ctx.chosenEvent.timeLabel;
    const yy = new Date(ctx.chosenEvent.startISO).getFullYear().toString().slice(-2);
    const cancelText = `Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia ${dd}/${yy} ${hhmm}.`;

    await sendWhatsAppText({ to: from, text: cancelText });

    // 9) Se era remarcar, oferecer horários (com "opção N")
    const shouldReschedule = convMem.after === "schedule";
    convMem.mode = null;
    convMem.after = null;

    if (shouldReschedule) {
      const slots = await listAvailableSlots({
        fromISO: new Date().toISOString(),
        days: 14,   // cobre mais dias
        limit: 12   // mais opções
      });

      let msg;
      if (!slots.length) {
        msg = "Cancelamento concluído. Vamos remarcar? Não encontrei horários nos próximos dias. " +
              "Se preferir, me diga uma **data específica** (ex.: 24/09).";
      } else {
        const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
        msg = "Cancelamento concluído. Vamos remarcar agora. Seguem as **opções**:\n" +
              linhas +
              '\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").\n' +
              'Se quiser ver **mais opções**, responda: **mais**.';
        convMem.lastSlots = slots;
        convMem.slotCursor = { fromISO: new Date().toISOString(), page: 1 };
        convMem.updatedAt = Date.now();
      }
      await sendWhatsAppText({ to: from, text: msg });
    }

    return; // não deixa cair em outras regras
  }
}
// === MODO RECUPERAR AGENDAMENTO (retrieve): usa nome/telefone e informa data/horário ===
{
  const convMem = getConversation(from);
  if (convMem?.mode === "retrieve") {
    const ctx = convMem.retrieveCtx || (convMem.retrieveCtx = { phone: "", name: "", list: null, chosen: null });


    // Atualiza identidade a partir desta mensagem
    const maybePhone = extractPhoneFromText(userText);
    if (maybePhone) ctx.phone = normalizePhoneForLookup(maybePhone);
    const maybeName = (extractNameFromText?.(userText) || "").trim();
    if (maybeName) ctx.name = maybeName;

    // Sem identidade suficiente → pedir de forma acolhedora
    if (!ctx.phone && !ctx.name) {
      await sendWhatsAppText({
        to: from,
        text:
          "Para eu localizar aqui, me envie **Telefone** (DDD + número) **e/ou** **Nome completo** como está no agendamento."
      });
      return;
    }

    // Busca no calendário (somente próximos/atuais)
    let events = [];
    try {
      const rawEvents = await findPatientEvents({
        phone: ctx.phone || "",
        name:  ctx.name  || "",
        daysBack: 365,
        daysAhead: 365
      });
      const now = Date.now();
      events = (rawEvents || [])
        .filter(ev => (ev.startISO ? new Date(ev.startISO).getTime() : 0) >= now - 5 * 60 * 1000)
        .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
    } catch (e) {
      console.error("[retrieve-mode] erro:", e?.message || e);
      events = [];
    }

    if (!events.length) {
      await sendWhatsAppText({
        to: from,
        text:
          "Não localizei agendamento **futuro** com os dados informados. " +
          "Pode confirmar **Telefone** (DDD + número) ou **Nome completo** como está no agendamento?"
      });
      return;
    }

    if (events.length === 1) {
      const ev = events[0];
      const yy = new Date(ev.startISO).getFullYear().toString().slice(-2);
      await sendWhatsAppText({
        to: from,
        text: `Encontrei: **${ev.dayLabel}/${yy} às ${ev.timeLabel}** — ${ev.summary || "Consulta"}.`
      });
      // Hand-off para a Cristina finalizar
try {
  const yy = new Date(ev.startISO).getFullYear().toString().slice(-2);
  const followUp = await askCristina({
    userText:
      `Contexto: o paciente pediu para lembrar o agendamento. ` +
      `Já informei: ${ev.dayLabel}/${yy} às ${ev.timeLabel} — ${ev.summary || "Consulta"}. ` +
      `Finalize com acolhimento e ofereça ajuda (reagendar, cancelar, instruções pré-consulta e endereço/telemedicina).`,
    userPhone: String(from)
  });

  if (followUp) {
    appendMessage(from, "assistant", followUp);
    await sendWhatsAppText({ to: from, text: followUp });
  }
} catch (e) {
  console.error("[retrieve->AI one] erro:", e?.message || e);
}

// Encerrar o modo retrieve
convMem.mode = null;
convMem.retrieveCtx = null;
convMem.updatedAt = Date.now();
return;

    }

    // Vários: apenas informar (sem pedir escolha) e hand-off para a Cristina
const top = events.slice(0, 5);
const linhas = top.map((ev, i) => {
  const yy = new Date(ev.startISO).getFullYear().toString().slice(-2);
  return `${i + 1}) ${ev.dayLabel}/${yy} — ${ev.timeLabel} — ${ev.summary || "Consulta"}`;
});

await sendWhatsAppText({
  to: from,
  text:
    "Encontrei agendamentos futuros associados ao seu nome/telefone:\n" +
    linhas.join("\n") +
    (events.length > 5 ? `\n... e mais ${events.length - 5}` : "")
});

// Hand-off para a Cristina finalizar com acolhimento/instruções
try {
  const followUp = await askCristina({
    userText:
      "Contexto: o paciente pediu para lembrar os agendamentos. " +
      "Acabei de informar a lista acima. Finalize com acolhimento e ofereça ajuda " +
      "(reagendar, cancelar, instruções pré-consulta e endereço/telemedicina).",
    userPhone: String(from)
  });

  if (followUp) {
    appendMessage(from, "assistant", followUp);
    await sendWhatsAppText({ to: from, text: followUp });
  }
} catch (e) {
  console.error("[retrieve->AI multi] erro:", e?.message || e);
}

// Encerrar o modo retrieve
convMem.mode = null;
convMem.retrieveCtx = null;
convMem.updatedAt = Date.now();
return;

  }
}

// === ATALHO: "opção N" + "mais" (somente fora do modo cancelamento) ===
try {
  const convMem = getConversation(from);
  if (convMem?.mode === "cancel" || convMem?.mode === "retrieve") {
    // ignorar durante cancelamento
  } else {
    const txt = (userText || "").trim().toLowerCase();

    // Paginação "mais"
    if (txt === "mais" || txt === "ver mais" || txt === "mais opções") {
      const cursor = convMem?.slotCursor || { fromISO: new Date().toISOString(), page: 1 };
      const base = new Date(cursor.fromISO);
      const nextFrom = new Date(base.getTime() + cursor.page * 7 * 86400000).toISOString();

      const more = await listAvailableSlots({ fromISO: nextFrom, days: 7, limit: 12 });
      if (!more.length) {
        await sendWhatsAppText({
          to: from,
          text: "Sem mais horários nesta janela. Se preferir, diga uma **data específica** (ex.: 30/09) ou peça outro dia da semana (ex.: \"próxima quinta\")."
        });
      } else {
        const linhas = more.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
        await sendWhatsAppText({
          to: from,
          text: "Aqui vão **mais opções**:\n" + linhas + '\n\nResponda com **opção N** ou informe **data e horário**.'
        });
        const convUpd = ensureConversation(from);
        convUpd.lastSlots = more;
        convUpd.slotCursor = { fromISO: nextFrom, page: (cursor.page || 1) + 1 };
        convUpd.updatedAt = Date.now();
      }
      return; // evita cair em outras regras neste turno
    }

    // "opção N" ou somente "N" (agora aceita "2)", "opção 3.", "escolho 4", etc.)
    const mOpt =
      txt.match(/^\s*op[cç][aã]o\s*(\d+)[).]?\s*$/i) ||
      txt.match(/^\s*(?:escolho|quero|vai\s*ser)?\s*(\d+)[).]?\s*$/i);

    if (mOpt && convMem?.lastSlots && Array.isArray(convMem.lastSlots)) {
      const idx = Number(mOpt[1]) - 1;
      const chosen = convMem.lastSlots[idx];

      if (!chosen) {
        await sendWhatsAppText({
          to: from,
          text: "Número inválido. Responda com **opção N** conforme a lista atual, ou peça **mais** para ver outras opções."
        });
        return;
      }

      // Converte a escolha em texto que já ativa o fluxo de criação
      const dt = new Date(chosen.startISO);
      const tz = process.env.TZ || "America/Sao_Paulo";
      const fmt = new Intl.DateTimeFormat("pt-BR", {
        timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
      }).formatToParts(dt).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
      const ddmmhhmm = `${fmt.day}/${fmt.month} ${fmt.hour}:${fmt.minute}`;
      userText = `Quero agendar nesse horário: ${ddmmhhmm}`;
      // segue o fluxo normal (sem return)
    }
  }
} catch (e) {
  console.error("[option-pick] erro:", e?.message || e);
}

    safeLog("INBOUND", req.body);
// === ENTENDE "tem dia 19?" (sem mês) e "próxima terça?" (dia da semana) ===
try {
  if ((getConversation(from)?.mode || null) !== "cancel") {
    const raw = String(userText || "").toLowerCase();
    const tz = process.env.TZ || "America/Sao_Paulo";

    // helpers
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const toISOStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();

    // 1) "tem dia 19?" / "dia 02" (sem mês)
    // evita conflito com dd/mm já tratado depois (não pode ter "/" nem "-")
    const mDayOnly = raw.match(/\b(?:tem\s+)?dia\s+(\d{1,2})\b(?!\s*[\/\-]\d)/i);

    // 2) "próxima terça?" (dia da semana)
    const mNextWeekday = raw.match(/\bpr(?:ó|o)xima\s+(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)s?\b/i);

    let targetDate = null;

    if (mDayOnly) {
      // Próximo dia do mês >= hoje; se já passou, mês seguinte; se não existir (ex.: 31/04), avança até existir
      const wantDay = Math.min(31, Number(mDayOnly[1]));
      const now = new Date();
      // tenta este mês
      let y = now.getFullYear();
      let m = now.getMonth(); // 0-11
      let candidate = new Date(y, m, wantDay, 0, 0, 0, 0);

      // se o "dia" retrocedeu (não existe esse dia neste mês) ou já passou hoje, vamos avançando mês a mês até achar
      const todayStart = startOfDay(now).getTime();
      let guard = 0;
      while (
        (candidate.getDate() !== wantDay) || // data "rolou" para outro dia => mês não tem esse dia
        (candidate.getTime() < todayStart)    // já passou (é antes de hoje 00:00)
      ) {
        m += 1;
        if (m > 11) { m = 0; y += 1; }
        candidate = new Date(y, m, wantDay, 0, 0, 0, 0);
        if (++guard > 24) break; // guarda-fio extremo
      }
      targetDate = candidate;
    }

    if (!targetDate && mNextWeekday) {
      const wkMap = {
        "domingo": 0, "segunda": 1, "terça": 2, "terca": 2,
        "quarta": 3, "quinta": 4, "sexta": 5, "sábado": 6, "sabado": 6
      };
      const want = wkMap[mNextWeekday[1].normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
      const now = new Date();
      const todayDow = now.getDay(); // 0=domingo
      let add = (want - todayDow + 7) % 7;
      if (add === 0) add = 7; // "próxima terça" nunca é hoje; é a da semana que vem
      targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, 0, 0, 0, 0);
    }

    if (targetDate) {
      // Listar opções deste dia
      const slots = await listAvailableSlots({
        fromISO: toISOStart(targetDate),
        days: 1,
        limit: 10
      });

      const convMem = ensureConversation(from);
      convMem.lastSlots = slots;
      convMem.updatedAt = Date.now();

      const { name } = extractPatientInfo({ payload: p, phone: from, conversation: getConversation(from) });

      // formata dd/mm
      const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" })
        .formatToParts(targetDate).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
      const ddmm = `${fmt.day}/${fmt.month}`;

      if (!slots.length) {
        const msg =
          `Olá${name ? `, ${name}` : ""}! Para **${ddmm}** não encontrei horários livres.\n` +
          `Posso te enviar alternativas próximas dessa data ou procurar outra data que você prefira.`;
        appendMessage(from, "assistant", msg);
        await sendWhatsAppText({ to: from, text: msg });
      } else {
        const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`);
        const msg =
          `Claro, seguem as opções para **${ddmm}**:\n` +
          linhas.join("\n") +
          `\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").`;
        appendMessage(from, "assistant", msg);
        await sendWhatsAppText({ to: from, text: msg });
      }
      return; // não deixa cair em outros blocos; evita travar o fluxo
    }
  }
} catch (e) {
  console.error("[day-only / next-weekday] erro:", e?.message || e);
}

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
// === GUARDA: paciente pescando datas com texto impreciso (re-prompt acolhedor, sem travar) ===
{
  const raw = (userText || "").toLowerCase();

  // sinais de que a pessoa está falando de datas/agenda, mas sem dar algo que nossas regras entendem
  const hintsDate = /\b(tem|dia|data|agenda|quando|qdo|pr[oó]xim[ao]s?|semana|segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado)\b/.test(raw);
  const hasExplicit = /(\b\d{1,2}[\/\-]\d{1,2}\b)|\b(\d{1,2}:\d{2})\b/.test(raw);
  const looksOption = /^\s*(op[cç][aã]o\s*)?\d+[).]?\s*$/.test(raw);

  if (hintsDate && !hasExplicit && !looksOption && (getConversation(from)?.mode || null) !== "cancel") {
    // Acolhe, pede no formato que destrava e segue o fluxo
    await sendWhatsAppText({
      to: from,
      text:
        "Claro! Posso te ajudar com a agenda. Me diga uma **data** (ex.: 24/09) ou responda com **opção N** da lista. " +
        "Se preferir, pode perguntar por um dia da semana (ex.: \"próxima quinta\")."
    });
    // Mantemos a conversa aberta (sem return) para que a IA também possa responder, se quiser.
  }
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

await createCalendarEvent({
  summary,
  description:
    description +
    `\n#patient_phone:${onlyDigits(phoneFormatted)}` +
    `\n#patient_name:${String(name || "").trim().toLowerCase()}`,
  startISO,
  endISO,
  attendees: [], // inclua e-mails só com consentimento
  location: process.env.CLINIC_ADDRESS || "Clínica",
  extendedProperties: {
    private: {
      patient_phone: onlyDigits(phoneFormatted),
      patient_name: String(name || "").trim().toLowerCase(),
      modality
    }
  }
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
