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
import { isSlotBlockedOrBusy } from "./availability.esm.js";
import {
  listAvailableSlots,
  listAvailableSlotsByDay,
  findDayOrNextWithSlots,
  formatSlotsForPatient,
  groupSlotsByDay,
} from "./slots.esm.js";



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
// === NLU helpers (IA em JSON) ===
function pickJSON(s){
  const t = String(s || "");
  const i = t.indexOf("{"); const j = t.lastIndexOf("}");
  return (i >= 0 && j > i) ? t.slice(i, j + 1) : null;
}
function safeParseJSON(s){
  try { return JSON.parse(s); } catch { return null; }
}
function toISODateUTC(y,m,d){
  return new Date(Date.UTC(y, m-1, d, 0, 0, 0)).toISOString();
}
function resolveWeekdayToISO({ weekdayIdx, wantNext=false, tz="America/Sao_Paulo" }){
  const now = new Date();
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit", weekday:"long" })
    .formatToParts(now).reduce((a,p)=>(a[p.type]=p.value,a),{});
  const yyyy = Number(parts.year), mm = Number(parts.month), dd = Number(parts.day);
  const todayName = new Intl.DateTimeFormat("pt-BR",{ timeZone: tz, weekday:"long"}).format(now)
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const todayIdx =
    /domingo/.test(todayName)?0:/segunda/.test(todayName)?1:/terca/.test(todayName)?2:
    /quarta/.test(todayName)?3:/quinta/.test(todayName)?4:/sexta/.test(todayName)?5:6;
  let delta = (weekdayIdx - todayIdx + 7) % 7;
  if (wantNext && delta === 0) delta = 7;
  return toISODateUTC(yyyy, mm, dd + delta);
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

  if ((v.match(/\d/g) || []).length >= 1) return false;      // rejeita se tiver número
  if (v.length < 3 || v.length > 80) return false;
  if (!/^[A-Za-zÀ-ÿ'’. -]+$/.test(v)) return false;

  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return false;

  const bad = /\b(agendar|consulta|presencial|telemedicina|quero|cancelar|remarcar|hor[áa]rio|dor|avaliac[aã]o|idade|telefone|motivo|endereco|endereço|data)\b/i;
  if (bad.test(v)) return false;

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
// === ATALHO: se o paciente responder "opção 3" (ou só "3"), injeta a data/hora do slot escolhido ===
try {
  const convMem = getConversation(from);
  const mOpt = (userText || "").match(/\bop(c[aã]o|ção)?\s*(\d+)\b|\b(\d+)\b/i);
  if (mOpt && convMem?.lastSlots && Array.isArray(convMem.lastSlots)) {
    const idx = Number(mOpt[2] || mOpt[3]) - 1;
    const chosen = convMem.lastSlots[idx];
    if (chosen) {
      // transforma em texto que sua IA já entende
      const dt = new Date(chosen.startISO);
      const tz = process.env.TZ || "America/Sao_Paulo";
      const pad = (n) => String(n).padStart(2, "0");
      const fmt = new Intl.DateTimeFormat("pt-BR", {
        timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
      }).formatToParts(dt)
        .reduce((acc, p) => (acc[p.type] = p.value, acc), {});
      const ddmmhhmm = `${fmt.day}/${fmt.month} ${fmt.hour}:${fmt.minute}`;
      userText = `Quero agendar nesse horário: ${ddmmhhmm}`;
    }
  }
} catch (e) {
  console.error("[option-pick] erro:", e?.message || e);
}
    // === AI NLU MIDDLEWARE: tenta interpretar e devolver JSON de intenção ===
try {
  const conv = getConversation(from) || {};
  const offer = conv.lastOffer || { days: [], map: {}, defaultYY: new Date().getFullYear().toString().slice(-2) };
  const tz = process.env.TZ || "America/Sao_Paulo";

  const nluPrompt =
`[[MODO_NLU_JSON]]
Você extrairá a intenção do usuário e responderá APENAS um JSON válido, sem texto extra.
Schema:
{
  "action": "list_by_date"|"list_near"|"book"|"cancel"|"unknown",
  "date":  "YYYY-MM-DD" | null,     // se usuário disse "23/09" ou "próxima terça", normalize p/ data absoluta
  "time":  "HH:MM" | null,          // 24h
  "weekday": "domingo|segunda|terca|quarta|quinta|sexta|sabado" | null,
  "relative": "amanha|depois_amanha|proxima_semana|esta_semana" | null,
  "modality": "presencial"|"telemedicina"|null,
  "notes": string,
  "confidence": number               // 0..1
}
Regras:
- Se houver dia da semana ("próxima terça", "quarta-feira"), preencha "weekday" e "relative"; e se possível já dê "date".
- Se houver apenas hora ("08:00", "8h") E existirem dias ofertados, mantenha time e deixe date=null.
- Se usuário citar explicitamente "23/09" (ou 23/09/25), preencha "date".
- Se pedir para ver horários, use action="list_by_date" (com date) ou "list_near" (sem date).
- Se pedir para marcar em um horário específico, use action="book".
- Nunca invente. Prefira null e confidence menor se ambíguo.

Contexto:
- timezone: ${tz}
- hoje (YYYY-MM-DD): ${new Date().toISOString().slice(0,10)}
- dias_ofertados_anteriores: ${offer?.days?.map(d=>d.dateKey).join(", ") || "nenhum"}

TEXTO_USUARIO:
"""${userText}"""`;

  // usamos a mesma função askCristina, forçando o modo NLU pelo texto
  const nluRaw = await askCristina({ userText: nluPrompt, userPhone: String(from) });
  const jsonStr = pickJSON(nluRaw);
  const nlu = safeParseJSON(jsonStr);

  if (nlu && nlu.confidence >= 0.55 && nlu.action && nlu.action !== "unknown") {
    // Normalizações leves no servidor (determinísticas)
    let targetISO = null;

    // 1) Se veio date (YYYY-MM-DD), usa direto
    if (nlu.date) {
      const [y,m,d] = nlu.date.split("-").map(Number);
      if (y && m && d) targetISO = toISODateUTC(y,m,d);
    }

    // 2) Se não veio date e veio relative/weekday, resolve aqui (determinístico)
    if (!targetISO && (nlu.weekday || nlu.relative)) {
      const wdIdx =
        nlu.weekday==="domingo"?0:nlu.weekday==="segunda"?1:nlu.weekday==="terca"?2:
        nlu.weekday==="quarta"?3:nlu.weekday==="quinta"?4:nlu.weekday==="sexta"?5:
        nlu.weekday==="sabado"?6:null;
      const wantNext = /proxima/.test(String(nlu.relative||""));
      if (wdIdx !== null) targetISO = resolveWeekdayToISO({ weekdayIdx: wdIdx, wantNext, tz });
      if (!targetISO && nlu.relative==="amanha") {
        const now = new Date();
        const parts = new Intl.DateTimeFormat("pt-BR",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"})
          .formatToParts(now).reduce((a,p)=>(a[p.type]=p.value,a),{});
        targetISO = toISODateUTC(Number(parts.year), Number(parts.month), Number(parts.day) + 1);
      }
      if (!targetISO && nlu.relative==="depois_amanha") {
        const now = new Date();
        const parts = new Intl.DateTimeFormat("pt-BR",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"})
          .formatToParts(now).reduce((a,p)=>(a[p.type]=p.value,a),{});
        targetISO = toISODateUTC(Number(parts.year), Number(parts.month), Number(parts.day) + 2);
      }
    }

    // 3) Decide a ação
    if (nlu.action === "list_by_date" && targetISO) {
      const { groups } = await findDayOrNextWithSlots({ targetISO, searchDays: 60, limitPerDay: 12 });
      const text = formatSlotsForPatient(groups);

      // atualiza memória lastOffer (dias/horas exibidos)
      const flatAll = [];
      for (const g of groups) {
        const [dd,mm,yy] = g.dateLabel.split("/");
        const yyyy = yy.length===2 ? Number("20"+yy) : Number(yy);
        const startUTC = toISODateUTC(yyyy, Number(mm), Number(dd));
        const flatDay = await listAvailableSlots({ fromISO: startUTC, days: 1, limit: 100 });
        flatAll.push(...flatDay);
      }
      const map = {}, days = [];
      const yyNow = new Date().getFullYear().toString().slice(-2);
      for (const s of flatAll) {
        const dateKey = (s.label || "").slice(0,8);
        const t = (s.label || "").slice(9,14);
        if (dateKey && t) {
          map[`${dateKey}|${t}`] = s.startISO;
          if (!days.some(d => d.dateKey === dateKey)) days.push({ dateKey });
        }
      }
      const convMem = ensureConversation(from);
      convMem.lastOffer = { map, days, defaultYY: yyNow, updatedAt: Date.now() };

      await sendWhatsAppText({ to: from, text });
      return;
    }

    if (nlu.action === "list_near") {
      const groups = await listAvailableSlotsByDay({ fromISO: new Date().toISOString(), days: 7, limitPerDay: 12 });
      const text = formatSlotsForPatient(groups);

      // memória
      const flat = await listAvailableSlots({ fromISO: new Date().toISOString(), days: 7, limit: 200 });
      const map = {}, days = [];
      const yyNow = new Date().getFullYear().toString().slice(-2);
      for (const s of flat) {
        const dateKey = (s.label || "").slice(0,8);
        const t = (s.label || "").slice(9,14);
        if (dateKey && t) { map[`${dateKey}|${t}`]=s.startISO; if(!days.some(d=>d.dateKey===dateKey)) days.push({dateKey}); }
      }
      const convMem = ensureConversation(from);
      convMem.lastOffer = { map, days, defaultYY: yyNow, updatedAt: Date.now() };

      await sendWhatsAppText({ to: from, text });
      return;
    }

    if (nlu.action === "book") {
      // Se vier date+time, converte para o formato que seu fluxo já entende
      if (targetISO && nlu.time) {
        const dt = new Date(`${targetISO.slice(0,10)}T${nlu.time}:00.000Z`);
        const parts = new Intl.DateTimeFormat("pt-BR",{
          timeZone: tz, day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"
        }).formatToParts(dt).reduce((a,p)=>(a[p.type]=p.value,a),{});
        const ddmmhhmm = `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
        userText = `Quero agendar nesse horário: ${ddmmhhmm}${nlu.modality?` (${nlu.modality})`:""}`;
        // Deixa seguir o fluxo normal (seus blocos de confirmação e criação de evento)
      }
      // Se veio só time, seu atalho "hora a partir da lista" cobre usando lastOffer; não mudamos aqui.
    }
    // Caso caia em "unknown" ou baixa confiança, seguimos pro seu fluxo atual.
  }
} catch (e) {
  console.error("[nlu] erro:", e?.message || e);
}
// === FIM AI NLU MIDDLEWARE ===

    
    // === INTERPRETAR PEDIDO DE DATA FUTURA & RESPONDER COM LAYOUT NOVO (sem "opção N") ===
try {
  const tz = process.env.TZ || "America/Sao_Paulo";
  const parsed = parseCandidateDateTime(userText, tz);

  // 1) Preferência: parser padrão (data + hora)
  let targetISO = parsed?.found ? parsed.startISO : null;

  // 2) Fallback: aceitar "só a data" (ex.: "12/09" ou "12/09/25")
  if (!targetISO) {
    const m = (userText || "").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const dd = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      let yyyy = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
      if (yyyy < 100) yyyy += 2000; // "25" -> 2025
      // 00:00 UTC do dia informado; a função findDayOrNextWithSlots normaliza para o dia local
      targetISO = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0)).toISOString();
    }
  }
// 2b) Fallback: dia da semana (ex.: "proxima terca", "quarta feira", "amanha", "depois de amanha")
if (!targetISO) {
  const tz = process.env.TZ || "America/Sao_Paulo";

  // normaliza acentos e caixa
  const raw = String(userText || "");
  const txt = raw
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove acentos

  // atalhos simples
  if (/\bamanha\b/.test(txt)) {
    // hoje em SP
    const parts = new Intl.DateTimeFormat("pt-BR",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date())
      .reduce((a,p)=> (a[p.type]=p.value, a), {});
    const yyyy = Number(parts.year), mm = Number(parts.month), dd = Number(parts.day);
    targetISO = new Date(Date.UTC(yyyy, mm-1, dd + 1, 0,0,0)).toISOString();
  } else if (/\bdepois de amanha\b/.test(txt)) {
    const parts = new Intl.DateTimeFormat("pt-BR",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date())
      .reduce((a,p)=> (a[p.type]=p.value, a), {});
    const yyyy = Number(parts.year), mm = Number(parts.month), dd = Number(parts.day);
    targetISO = new Date(Date.UTC(yyyy, mm-1, dd + 2, 0,0,0)).toISOString();
  } else {
    // mapeia nomes de dias (com/sem "-feira")
    const wantNext = /\b(proxim[ao]|que vem)\b/.test(txt); // "próxima terça", "terça que vem"
    const wdNames = [
      { rx: /\bdomingo\b/,                  idx: 0 },
      { rx: /\bsegunda(?:-feira)?\b/,       idx: 1 },
      { rx: /\bterca(?:-feira)?\b/,         idx: 2 },
      { rx: /\bquarta(?:-feira)?\b/,        idx: 3 },
      { rx: /\bquinta(?:-feira)?\b/,        idx: 4 },
      { rx: /\bsexta(?:-feira)?\b/,         idx: 5 },
      { rx: /\bsabado(?:-feira)?\b/,        idx: 6 },
    ];
    const wanted = wdNames.find(w => w.rx.test(txt));

    if (wanted) {
      // dia de hoje em São Paulo
      const todayName = new Intl.DateTimeFormat("pt-BR",{ timeZone: tz, weekday:"long"}).format(new Date())
        .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const todayIdx =
        /domingo/.test(todayName) ? 0 :
        /segunda/.test(todayName) ? 1 :
        /terca/.test(todayName)   ? 2 :
        /quarta/.test(todayName)  ? 3 :
        /quinta/.test(todayName)  ? 4 :
        /sexta/.test(todayName)   ? 5 : 6;

      let delta = (wanted.idx - todayIdx + 7) % 7; // próximo desse dia (pode ser hoje)
      if (wantNext) {
        // "próxima terça": se for hoje, pula 7 dias; senão, o delta já cai na próxima semana quando apropriado
        if (delta === 0) delta = 7;
      }

      const parts = new Intl.DateTimeFormat("pt-BR",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date())
        .reduce((a,p)=> (a[p.type]=p.value, a), {});
      const yyyy = Number(parts.year), mm = Number(parts.month), dd = Number(parts.day);
      targetISO = new Date(Date.UTC(yyyy, mm-1, dd + delta, 0,0,0)).toISOString();
    }
  }
}

  // 3) Se identificamos uma data (com ou sem hora), listar o dia ou o próximo com vagas
    if (targetISO) {
    const res = await findDayOrNextWithSlots({
      targetISO,
      searchDays: 60,
      limitPerDay: 12
    });
    const { status, groups } = res;
    const text = formatSlotsForPatient(groups);

    // === Monta flat para os dias exibidos, para alimentar a memória
    // Para cada grupo (dia), buscamos os slots daquele dia (1 dia)
    const flatAll = [];
    for (const g of groups) {
      // g.dateLabel = "dd/mm/aa"
      const [dd, mm, yy] = g.dateLabel.split("/");
      const yyyy = Number(yy.length === 2 ? ("20" + yy) : yy);
      const dayStartUTC = new Date(Date.UTC(yyyy, Number(mm)-1, Number(dd), 0, 0, 0)).toISOString();

      const flatDay = await listAvailableSlots({ fromISO: dayStartUTC, days: 1, limit: 100 });
      flatAll.push(...flatDay);
    }

    // Guarda mapeamento data/hora -> startISO
    const convMem = ensureConversation(from);
    const map = {};
    const days = [];
    const yyNow = new Date().getFullYear().toString().slice(-2);
    for (const s of flatAll) {
      const dateKey = (s.label || "").slice(0, 8);
      const time    = (s.label || "").slice(9, 14);
      if (dateKey && time) {
        map[`${dateKey}|${time}`] = s.startISO;
        if (!days.some(d => d.dateKey === dateKey)) days.push({ dateKey });
      }
    }
    convMem.lastOffer = { map, days, defaultYY: yyNow, updatedAt: Date.now() };

    await sendWhatsAppText({ to: from, text });
    return;
  }
} catch (e) {
  console.error("[date-query] erro:", e?.message || e);
}
// === FIM DATA FUTURA ===
// === ATALHO: interpretar resposta de hora baseada na ÚLTIMA LISTA oferecida (sem "opção N")
try {
  const convMem = getConversation(from);
  const offer = convMem?.lastOffer;
  if (offer?.map && offer?.days?.length) {
    const txt = String(userText || "");
    // 1) Capturar hora: "08:00" ou "8h" / "8H"
    let time = null;
    const m1 = txt.match(/\b(\d{1,2}):(\d{2})\b/);
    const m2 = txt.match(/\b(\d{1,2})h\b/i);
    if (m1) {
      const hh = m1[1].padStart(2, "0");
      const mm = m1[2].padStart(2, "0");
      time = `${hh}:${mm}`;
    } else if (m2) {
      const hh = m2[1].padStart(2, "0");
      time = `${hh}:00`;
    }

    if (time) {
      // 2) Capturar data (opcional): "23/09" ou "23/09/25"
      let dateKey = null;
      const md = txt.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      if (md) {
        const dd = md[1].padStart(2, "0");
        const mm = md[2].padStart(2, "0");
        let yy = md[3] ? md[3] : offer.defaultYY; // usa ano "padrão" se não veio
        if (yy.length === 4) yy = yy.slice(-2);
        dateKey = `${dd}/${mm}/${yy}`;
      } else {
        // Sem data no texto: se só 1 dia foi ofertado, usar esse dia; se mais, tenta "neste dia"
        const txtLow = txt.toLowerCase();
        if (offer.days.length === 1 || /\bneste\s+dia|\bnesse\s+dia|\bno\s+mesmo\s+dia/i.test(txtLow)) {
          dateKey = offer.days[0].dateKey;
        }
      }
// Se não veio dd/mm e há nome de dia ("terca", "quarta", ...), tente casar com um dos dias ofertados
if (!dateKey) {
  const tz = process.env.TZ || "America/Sao_Paulo";
  const plain = txtLow.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // sem acento

  const wd = [
    { rx: /\bdomingo\b/,            idx: 0 },
    { rx: /\bsegunda(?:-feira)?\b/, idx: 1 },
    { rx: /\bterca(?:-feira)?\b/,   idx: 2 },
    { rx: /\bquarta(?:-feira)?\b/,  idx: 3 },
    { rx: /\bquinta(?:-feira)?\b/,  idx: 4 },
    { rx: /\bsexta(?:-feira)?\b/,   idx: 5 },
    { rx: /\bsabado(?:-feira)?\b/,  idx: 6 },
  ].find(w => w.rx.test(plain));

  if (wd) {
    // procura entre os dias ofertados um que tenha esse dia-da-semana
    for (const d of offer.days) {
      // d.dateKey = "dd/mm/aa"
      const [dd, mm, yy] = d.dateKey.split("/");
      const yyyy = Number("20" + yy);
      // meio-dia UTC evita problemas de fuso/borda
      const when = new Date(Date.UTC(yyyy, Number(mm)-1, Number(dd), 12, 0, 0));
      const dowName = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" })
        .format(when)
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      const idx =
        /domingo/.test(dowName) ? 0 :
        /segunda/.test(dowName) ? 1 :
        /terca/.test(dowName)   ? 2 :
        /quarta/.test(dowName)  ? 3 :
        /quinta/.test(dowName)  ? 4 :
        /sexta/.test(dowName)   ? 5 : 6;

      if (idx === wd.idx) { dateKey = d.dateKey; break; }
    }
  }
}

      if (dateKey) {
        const chosenISO = offer.map[`${dateKey}|${time}`];
        if (chosenISO) {
          // Constrói texto que o fluxo já entende (como fazemos no "opção N")
          const dt = new Date(chosenISO);
          const tz = process.env.TZ || "America/Sao_Paulo";
          const parts = new Intl.DateTimeFormat("pt-BR", {
            timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
          }).formatToParts(dt).reduce((acc,p)=> (acc[p.type]=p.value, acc), {});
          const ddmmhhmm = `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
          userText = `Quero agendar nesse horário: ${ddmmhhmm}`;
          // (Deixa seguir o fluxo normal — IA/regex de confirmação etc.)
        }
      }
    }
  }
} catch (e) {
  console.error("[time-pick-from-offer] erro:", e?.message || e);
}
// === FIM ATALHO DE HORA A PARTIR DA LISTA ===    
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
let finalAnswer = answer;

// === SE A IA MENCIONAR QUE VAI ENVIAR HORÁRIOS, ANEXA JÁ NO LAYOUT NOVO (sem numeração) ===
try {
  const shouldList = /vou te enviar os hor[aá]rios livres/i.test(answer || "");
  if (shouldList) {
    // Pegamos a lista "plana" e também agrupamos para formatar
    const flat = await listAvailableSlots({
      fromISO: new Date().toISOString(),
      days: 7,
      limit: 200
    });
    const groups = groupSlotsByDay(flat);

    if (!groups.length) {
      finalAnswer = "No momento não encontrei janelas livres nos próximos dias.";
    } else {
      finalAnswer = formatSlotsForPatient(groups);
    }

    // === Guarda mapeamento data/hora -> startISO na memória (para entender "neste dia 08:00")
    const convMem = ensureConversation(from);
    const map = {};         // chave: "dd/mm/aa|HH:MM"  -> startISO
    const days = [];        // [{ dateKey }]
    const yyNow = new Date().getFullYear().toString().slice(-2);

    for (const s of flat) {
      // s.label = "dd/mm/aa HH:MM"
      const dateKey = (s.label || "").slice(0, 8);
      const time    = (s.label || "").slice(9, 14);
      if (dateKey && time) {
        map[`${dateKey}|${time}`] = s.startISO;
        if (!days.some(d => d.dateKey === dateKey)) days.push({ dateKey });
      }
    }

    convMem.lastOffer = {
      map,               // lookup rápido
      days,              // lista de datas ofertadas
      defaultYY: yyNow,  // para completar ano quando o usuário digitar só dd/mm
      updatedAt: Date.now()
    };
  }
} catch (e) {
  console.error("[slots-append] erro:", e?.message || e);
}


    
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
  const alternativas = await listAvailableSlots({ fromISO: startISO, days: 7, limit: 5 });
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
  description,
  startISO,
  endISO,
  attendees: [], // inclua e-mails só com consentimento
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
    if (finalAnswer) {
  appendMessage(from, "assistant", finalAnswer);
  await sendWhatsAppText({ to: from, text: finalAnswer });
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
