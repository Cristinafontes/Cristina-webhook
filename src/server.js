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
import { sendZapiText } from "./zapi.js";
import { safeLog } from "./redact.js";

// >>> CALENDÁRIO (somente nossas funções)
import { createCalendarEvent, findPatientEvents, cancelCalendarEvent } from "./google.esm.js";
import { parseCandidateDateTime } from "./utils.esm.js";
import { isSlotBlockedOrBusy } from "./availability.esm.js";
import { listAvailableSlots } from "./slots.esm.js";
// <<< FIM CALENDÁRIO

// === CONFIG QUE CONTROLA QUANTAS OPÇÕES MOSTRAR POR PÁGINA ===
const SLOTS_PAGE_SIZE = parseInt(process.env.SLOTS_PAGE_SIZE || "4", 10); // 4 pedidas
const MORE_SLOTS_DAYS = 7; // janela da paginação "mais" (pode manter 7)

// (opcional) liga/desliga limpeza de *negrito* e ativa placeholder {{nome}}
const WHATSAPP_STRIP_MARKDOWN = String(process.env.WHATSAPP_STRIP_MARKDOWN || "true").toLowerCase() === "true";

// ===== Helper de envio unificado (Z-API ou Gupshup) =====
// Versão "segura": jitter, cooldown por contato e deduplicação
const _lastSendAtByPhone = new Map(); // phone -> timestamp
const _lastPayloadByPhone = new Map(); // phone -> { text, at }
// Anti-duplicação de entrada (texto do usuário)
const _lastInboundByPhone = new Map(); // phone -> { textNorm, at }
function _normInboundText(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Contador diário por contato
const _dailyCountByPhone = new Map(); // key="YYYYMMDD|phone" -> count
function _dayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}
function _getDaily(key) { return _dailyCountByPhone.get(key) || 0; }
function _incDaily(key) { _dailyCountByPhone.set(key, _getDaily(key) + 1); }


function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _isQuietHours(now = new Date()) {
  try {
    const cfg = String(process.env.QUIET_HOURS || "").trim(); // ex: "21-08"
    if (!cfg) return false;
    const [h1, h2] = cfg.split("-").map(x => parseInt(x, 10));
    if (Number.isNaN(h1) || Number.isNaN(h2)) return false;
    const hr = now.getHours();
    if (h1 < h2) return hr >= h1 && hr < h2;        // 10-18
    return hr >= h1 || hr < h2;                     // 21-08 (vira a meia-noite)
  } catch { return false; }
}

async function sendText({ to, text }) {
  // mantém compatibilidade com o resto do código
  const provider = (process.env.WHATSAPP_PROVIDER || "GUPSHUP").toUpperCase();
  const phone = (to || "").toString().replace(/\D/g, "");

    // --- Limite diário por contato (anti-rajada agressiva) ---
  try {
    const MAX_PER_DAY = parseInt(process.env.MAX_MSGS_PER_CONTACT_PER_DAY || "20", 10);
    const key = `${_dayKey()}|${phone}`;
    const count = _getDaily(key);

    // Permite resposta se o usuário falou há ≤60s, mesmo após o limite
    const conv = conversations.get(phone);
    const lastUserAt = conv?.lastUserAt || 0;
    const userIsRecent = Date.now() - lastUserAt <= 60_000;

    if (count >= MAX_PER_DAY && !userIsRecent) {
      console.log("[sendText] daily-cap: segurando envio para", phone);
      return { skipped: "daily-cap" };
    }
  } catch {}

    // 0) formata mensagem (nome + tira *...* se quiser)
    const raw = String(text || "");
  const convSnap = getConversation(phone);
  const pname = (convSnap && convSnap.patientName && convSnap.patientName !== "Paciente (WhatsApp)")
    ? convSnap.patientName : "";
  let msg = raw.replace(/\{\{\s*nome\s*\}\}/gi, pname); // suporta placeholder {{nome}}
  if (WHATSAPP_STRIP_MARKDOWN) {
  // remove *negrito* e ***variações*** sem quebrar o texto
  msg = msg.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
}

  // 1) Deduplicação: ignora se mesma mensagem foi enviada nos últimos X segundos
  try {
    const DEDUPE_WINDOW_MS = parseInt(process.env.DEDUPE_WINDOW_MS || "30000", 10);
    const last = _lastPayloadByPhone.get(phone);
    if (last && last.text === msg && Date.now() - last.at < DEDUPE_WINDOW_MS) {
      console.log("[sendText] dedupe: ignorando repetição para", phone);
      return { skipped: "dedupe" };
    }
  } catch {}

  // 1.5) Evita iniciar outbound depois de muito silêncio do paciente
  try {
    const MAX_SILENCE = parseInt(process.env.MAX_SILENCE_BEFORE_OUTBOUND_MS || "300000", 10); // 5min
    const conv = conversations.get(phone);
    const lastUserAt = conv?.lastUserAt || 0;
    // Se o paciente não falou recentemente e não há pergunta pendente, segure
    if (lastUserAt && Date.now() - lastUserAt > MAX_SILENCE) {
      console.log("[sendText] long-silence: evitando outbound frio para", phone);
      return { skipped: "long-silence" };
    }
  } catch {}

  
  // 2) Quiet hours para primeiro contato frio (não bloqueia respostas)
  // Se QUIET_ALLOW_REPLY=true, liberamos quando houve mensagem do usuário agora.
  try {
    const allowReply = String(process.env.QUIET_ALLOW_REPLY || "true").toLowerCase() === "true";
    if (_isQuietHours() && allowReply) {
      // Se não existe conversa recente, evite iniciar push frio neste horário
      const conv = conversations.get(phone);
      const hasRecentUserMsg = !!(conv && conv.messages && conv.messages.some(m => m.role === "user"));
      if (!hasRecentUserMsg) {
        console.log("[sendText] quiet-hours: evitando iniciar conversa com", phone);
        return { skipped: "quiet-hours" };
      }
    }
  } catch {}

  // 3) Intervalo mínimo por contato (anti-rajada)
  try {
    const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL_PER_CONTACT_MS || "15000", 10);
    const lastAt = _lastSendAtByPhone.get(phone) || 0;
    const delta = Date.now() - lastAt;
    if (delta < MIN_INTERVAL) {
      const wait = MIN_INTERVAL - delta;
      console.log(`[sendText] cooldown ${wait}ms para ${phone}`);
      await _sleep(wait);
    }
  } catch {}

  // 4) Jitter humano (2–6s por default)
  try {
    const MIN_D = parseInt(process.env.MIN_DELAY_MS || "2000", 10);
    const MAX_D = parseInt(process.env.MAX_DELAY_MS || "6000", 10);
    const jitter = _randInt(MIN_D, Math.max(MIN_D, MAX_D));
    await _sleep(jitter);
  } catch {}

  // 5) Envio pelo provedor selecionado (sem alterar sua lógica)
  let out;
  if (provider === "ZAPI") {
    out = await sendZapiText({ phone, message: msg });
  } else {
    out = await sendWhatsAppText({ to, text: msg });
  }

  // 6) Marcações para as próximas proteções
  _lastSendAtByPhone.set(phone, Date.now());
  _lastPayloadByPhone.set(phone, { text: msg, at: Date.now() });
  // contabiliza envio do dia
  try { _incDaily(`${_dayKey()}|${phone}`); } catch {}

  return out;
}
// ===== FIM do helper =======================================================


dotenv.config();
const app = express();
app.set("trust proxy", 1);
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
// === Webhook Z-API (mensagens recebidas) ===
app.post("/webhook/zapi", async (req, res) => {
  // Confirma rápido para a Z-API
  res.sendStatus(200);

  try {
    const b = req.body || {};

    // (Opcional) Se você deixou ligado "Notificar as enviadas por mim também",
    // ignore eventos de mensagens enviadas pela própria instância para evitar loop:
    if (b?.owner === true || b?.status === "SENT") return;

    // Texto do usuário
    const inboundText =
      b?.text?.message ||
      b?.message?.text?.message ||
      b?.message?.body ||
      "";

    // Número do usuário
    const fromRaw = (b?.phone || b?.message?.from || "") + "";
    const from = fromRaw.replace(/\D/g, "");

    if (!inboundText || !from) return;

    // MONTA um "evento no formato Gupshup" e reutiliza TODO o fluxo
    req.body = {
      type: "message",
      payload: {
        type: "text",
        payload: { text: inboundText },
        sender: { phone: from },
        source: from
      }
    };

    // chama o mesmo handler usado pela Gupshup
    await handleInbound(req, res);
  } catch (e) {
    console.error("[/webhook/zapi] erro:", e?.response?.data || e);
  }
});
// =====================
// Memória por telefone
// =====================
const MEMORY_TTL_HOURS = Number(process.env.MEMORY_TTL_HOURS || 48);
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
// === Utils de data ===
function isWeekend(dateOrISO) {
  const d = new Date(dateOrISO);
  const dow = d.getDay(); // 0=dom, 6=sáb
  return dow === 0 || dow === 6;
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
  const v = String(s || "").trim();
  if (!v) return false;

  // rejeita números / símbolos estranhos
  if ((v.match(/\d/g) || []).length >= 1) return false;
  if (!/^[A-Za-zÀ-ÿ'’. -]+$/.test(v)) return false;

  const parts = v.split(/\s+/).filter(Boolean);
  // *** agora exige no mínimo 2 palavras ***
  if (parts.length < 2 || parts.length > 6) return false;

  // blacklist forte de termos que não podem estar em nome
  const BAN = /\b(avalia[cç][aã]o|pr[eé][-\s]?anest|anestesia|medicina|dor|consulta|retorno|hor[áa]rio|modalidade|telefone|idade|end(?:ere[cç]o)?|paciente|motivo|preop|pré|pre)\b/i;
  if (BAN.test(v)) return false;

  // partículas comuns são ok (da, de, dos, e...)
  const particle = /^(da|de|do|das|dos|e|d['’]?)$/i;
  for (const w of parts) {
    if (particle.test(w)) continue;
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*$/.test(w)) return false;
  }
  return true;
}
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

  // rejeita números e caracteres inválidos
  if ((v.match(/\d/g) || []).length >= 1) return false;
  if (v.length < 3 || v.length > 80) return false;
  if (!/^[A-Za-zÀ-ÿ'’. -]+$/.test(v)) return false;

  const parts = v.split(/\s+/).filter(Boolean);
  // *** agora exige no mínimo 2 palavras ***
  if (parts.length < 2 || parts.length > 6) return false;

  // blacklist reforçada
  const BAN =
    /\b(avalia[cç][aã]o|pr[eé][-\s]?anest|anestesia|medicina|dor|consulta|retorno|hor[áa]rio|modalidade|telefone|idade|end(?:ere[cç]o)?|paciente|motivo|preop|pré|pre)\b/i;
  if (BAN.test(v)) return false;

  // dias e meses não são nome
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
// *** hardening final: exige 2+ palavras mesmo após escolha ***
if (name && name.split(/\s+/).filter(Boolean).length < 2) {
  name = "Paciente (WhatsApp)";
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
  if (role === "user") conv.lastUserAt = nowMs();
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

    // --- Anti-duplicação de entrada (antes de ler msgType) ---
{
  const now = Date.now();
  const last = _lastInboundByPhone.get(from);
  const bodyForDedupe =
    (p?.payload?.text ?? p?.payload?.title ?? p?.payload?.postbackText ?? "") + "";
  const textNorm = _normInboundText(bodyForDedupe);
  const WINDOW_MS = 10_000; // 10s
  if (last && last.textNorm === textNorm && now - last.at < WINDOW_MS) {
    console.log("[inbound dedupe] repetido ignorado para", from);
    return;
  }
  _lastInboundByPhone.set(from, { textNorm, at: now });
}

    if (msgType === "text") {
      userText = p?.payload?.text || "";
    } else if (msgType === "button_reply" || msgType === "list_reply") {
      userText = p?.payload?.title || p?.payload?.postbackText || "";
    } else {
      await sendText({
        to: from,
        text: "Por ora, consigo ler apenas mensagens de texto. Pode tentar novamente?",
      });
      return;
    }

    const trimmed = (userText || "").trim().toLowerCase();
  // === MEMÓRIA DE IDENTIDADE (nome/telefone) ===
{
  const conv = ensureConversation(from);
  const picked = extractPatientInfo({ payload: p, phone: from, conversation: conv });
  if (picked?.name && picked.name !== "Paciente (WhatsApp)") conv.patientName = picked.name;
  conv.lastKnownPhone = from;
}

    if (["reset", "reiniciar", "reiniciar conversa", "novo atendimento"].includes(trimmed)) {
  resetConversation(from);
  return;
}
  // === BLACKLIST DE SAUDAÇÕES (não dispara pescagem nem agendamento) ===
const isPureGreeting =
  /^(bom\s*dia|boa\s*tarde|boa\s*noite|ol[áa]|oi)\s*!?\.?$/i.test((userText || "").trim());
if (isPureGreeting) {
  // Não responda nada aqui.
  // Deixe seguir para a IA — e evite qualquer autolista neste turno.
  ensureConversation(from).justPickedOption = true; // “trava” a autolista só neste turno
  // (sem return)
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

    await sendText({
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

    
await sendText({
  to: from,
  text:
    "Certo, vamos **cancelar**. Para eu localizar seu agendamento, me envie **Telefone** (DDD + número) **e/ou** **Nome completo**.\n" +
    "Se você souber, **data e horário** também me ajudam a localizar (ex.: 26/09 09:00)."
});
return;
  }
}
// ====== [IDENTIDADE DO PACIENTE] Helpers de comparação por telefone/nome ======
function normalizeStrLite(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ")
    .trim();
}
function strip55(digits) {
  const d = onlyDigits(digits);
  if (!d) return "";
  return d.startsWith("55") ? d.slice(2) : d;
}
function phonesEqual(a, b) {
  const A = strip55(a); // nacional (10-11)
  const B = strip55(b);
  if (!A || !B) return false;
  // compara últimos 11; se não houver, últimos 10
  const tail = Math.max(10, Math.min(11, Math.max(A.length, B.length)));
  return A.slice(-tail) === B.slice(-tail);
}

// varre possíveis telefones/nome dentro do evento do Google Calendar
function extractPhonesFromEvent(ev) {
  const out = new Set();
  const add = (v) => { const d = onlyDigits(v); if (d) out.add(d); };

  // extendedProperties.private.patient_phone
  const pvt = ev?.extendedProperties?.private || {};
  if (pvt.patient_phone) add(pvt.patient_phone);

  // descrição (marca #patient_phone:XXXXXXXX)
  if (ev?.description) {
    const m = ev.description.match(/#patient_phone:([0-9]+)/i);
    if (m?.[1]) add(m[1]);
    // fallback: captura blocos de 10+ dígitos
    const all = ev.description.match(/\b\d{10,13}\b/g);
    (all || []).forEach(add);
  }

  // título pode ter telefone
  if (ev?.summary) {
    const all = ev.summary.match(/\b\d{10,13}\b/g);
    (all || []).forEach(add);
  }

  return Array.from(out);
}

function extractNamesFromEvent(ev) {
  const out = new Set();
  const add = (v) => { const n = normalizeStrLite(v); if (n) out.add(n); };

  // extendedProperties.private.patient_name
  const pvt = ev?.extendedProperties?.private || {};
  if (pvt.patient_name) add(pvt.patient_name);

  // descrição "Paciente: Fulano"
  if (ev?.description) {
    const m = ev.description.match(/^\s*Paciente:\s*(.+)$/im);
    if (m?.[1]) add(m[1]);
    const mTag = ev.description.match(/#patient_name:([^\n\r]+)/i);
    if (mTag?.[1]) add(mTag[1]);
  }

  // título "Consulta (...) — Nome — ..."
  if (ev?.summary) {
    // pega o trecho entre travessões como possível nome
    const parts = ev.summary.split("—").map(s => s.trim());
    for (const part of parts) {
      if (part && /[A-Za-zÀ-ÿ]/.test(part)) add(part);
    }
  }
  return Array.from(out);
}

function eventMatchesIdentity(ev, { phone, name }) {
  // Se fornecer telefone, ele DEVE bater
  if (phone) {
    const evPhones = extractPhonesFromEvent(ev);
    const okPhone = evPhones.some(p => phonesEqual(p, phone));
    if (!okPhone) return false;
  }
  // Se fornecer nome, ele DEVE bater
  if (name) {
    const target = normalizeStrLite(name);
    const evNames = extractNamesFromEvent(ev);

    // Casa exato OU por inclusão (parcial), para tolerar variações.
    const okName = evNames.some(n =>
      n === target || n.includes(target) || target.includes(n)
    );

    if (!okName) return false;
  }
  return true;
}
// === Sidecar da IA durante o CANCELAMENTO (não reinicia conversa) ===
async function aiAssistCancel({ from, userText }) {
  const conv = getConversation(from) || ensureConversation(from);
  const ctx  = conv.cancelCtx || {};
  // Monta um prompt curto e CONTEXTUALIZADO com a etapa do cancelamento
  const stageHints = [
    ctx.awaitingConfirm ? "ETAPA: aguardando confirmação 'sim' ou 'não' do cancelamento." : null,
    (!ctx.phone && !ctx.name) ? "ETAPA: aguardando identidade (Telefone e/ou Nome)." : null,
    (ctx.phone || ctx.name) && !ctx.chosenEvent ? "ETAPA: localizando/selecionando o agendamento correto." : null,
    (ctx.confirmed) ? "ETAPA: cancelamento confirmado; preparando execução." : null
  ].filter(Boolean).join(" ");

  // Hints invisíveis pra IA (sem reapresentação e sem reiniciar a conversa)
  const invisibleHints =
    "NÃO se reapresente. Responda acolhedoramente e direto ao ponto, com tom da clínica. " +
    "Se o paciente quiser MUDAR O FLUXO (ex.: reagendar), acolha e diga explicitamente o que faremos em seguida. " +
    "Finalize sempre com uma frase que devolva o paciente para a etapa atual (ou explique a mudança).";

  // Renderiza histórico recente no formato já usado no arquivo
  const lines = (conv.messages || []).map(m => m.role === "user"
    ? `Paciente: ${m.content}`
    : `Cristina: ${m.content}`
  );
  lines.push(`Paciente: ${userText}`);

  let composed =
    `Contexto de conversa (mais recente por último):\n` +
    lines.join("\n") +
    `\n\n[ETAPA DO CANCELAMENTO] ${stageHints || "ETAPA: fluxo de cancelamento em andamento."}\n` +
    `[HINTS (NÃO MOSTRAR AO PACIENTE)]: ${invisibleHints}`;

  // Chama a IA reaproveitando sua função existente
  const answer = await askCristina({ userText: composed, userPhone: String(from) });

  // Memória + envio
  appendMessage(from, "user", userText);
  if (answer) {
    appendMessage(from, "assistant", answer);
    await sendText({ to: from, text: answer });

    // Se a IA detectar intenção de remarcar, sinalizamos para o pós-cancelamento
    try {
      const wantsReschedule = /\b(reagend|remarc|mudar\s*hor[áa]rio|adiar)\b/i.test(answer);
      if (wantsReschedule) {
        const c = ensureConversation(from);
        if (c?.mode === "cancel") c.after = "schedule";
      }
    } catch {}
  }
}

// === MODO CANCELAMENTO: coletar dados (telefone/nome/data) e cancelar com base em 1+ campos ===
{
  const convMem = getConversation(from);
  if (convMem?.mode === "cancel") {
    const ctx = convMem.cancelCtx || (convMem.cancelCtx = { phone: "", name: "", dateISO: null, timeHHMM: null, chosenEvent: null });
    // Se estamos aguardando confirmação do cancelamento:
if (ctx.awaitingConfirm) {
    const yes = /\b(sim|pode|confirmo|confirmar|ok|isso|pode\s*cancelar|pode\s*sim|tudo\s*certo)\b/i.test(userText || "");
  const no  = /\b(n[aã]o|negativo|melhor\s*n[aã]o|cancelar\s*n[aã]o|pera|espera|a?guarda|deixa\s*quieto)\b/i.test(userText || "");


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

    await sendText({
      to: from,
      text:
        "Sem problema! Posso **manter** seu agendamento, **tirar dúvidas** sobre a consulta, ou, se preferir, posso **remarcar** para outro dia/horário. Como posso te ajudar agora?"
    });
    return;
  } else {
    // não entendi; reapresenta o pedido, sem travar
    await sendText({
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
    await sendText({ to: from, text: "Número inválido. Responda com 1, 2, 3 conforme a lista." });
    return;
  }
}

    // 1) Tentar extrair telefone e nome do texto livre (último dado prevalece)
// telefone
const maybePhone = extractPhoneFromText(userText);
if (maybePhone) {
  ctx.phone = normalizePhoneForLookup(maybePhone);

  // *** reset defensivo ao trocar telefone ***
  ctx.dateISO = null;
  ctx.timeHHMM = null;
  ctx.chosenEvent = null;
  ctx.matchList = [];
  ctx.awaitingConfirm = false;
  ctx.confirmed = false;
}

// nome (reaproveita seu extrator robusto)
const candidateNameRaw = extractNameFromText?.(userText);
const candidateName = (candidateNameRaw || "").trim();

// Aceita só "nome de verdade": tem espaço (nome + sobrenome) OU ≥ 4 letras.
// Evita confundir "Sim", "Ok", etc. com nome.
if (candidateName && (/\s/.test(candidateName) || candidateName.replace(/\s+/g, "").length >= 4)) {
  ctx.name = candidateName;

  // *** reset defensivo ao trocar nome ***
  ctx.dateISO = null;
  ctx.timeHHMM = null;
  ctx.chosenEvent = null;
  ctx.matchList = [];
  ctx.awaitingConfirm = false;
  ctx.confirmed = false;
}
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
// === OFF-SCRIPT GUARD (chama IA se a resposta não é o que o fluxo espera) ===
{
  const raw = String(userText || "");

    const saidYes = /\b(sim|pode|confirmo|confirmar|ok|isso|pode cancelar)\b/i.test(raw);
  const saidNo  = /\b(n[aã]o|negativo|melhor n[aã]o|cancelar n[aã]o)\b/i.test(raw);

  // Captura respostas numéricas simples, com "opção", "opcao", "escolho", etc.
  const pickedNumberOnly =
    /^\s*\d{1,2}\s*$/.test(raw) ||                       // Ex.: "2"
    /^\s*op[cç][aã]o\s*\d{1,2}\s*$/.test(raw) ||        // Ex.: "opção 2"
    /^\s*escolho\s*\d{1,2}\s*$/.test(raw) ||            // Ex.: "escolho 2"
    /^\s*(?:op[cç][aã]o|opcao)\s*\d{1,2}[).]?\s*$/.test(raw); // Ex.: "opcao 2)" ou "opção 3."

  const gavePhone = Boolean(maybePhone);
  const gaveName  = Boolean(candidateName);
  const gaveDateOrTime = Boolean(mDate || mTime);


  const offScript =
    !saidYes &&
    !saidNo &&
    !pickedNumberOnly &&
    !gavePhone &&
    !gaveName &&
    !gaveDateOrTime;

  if (offScript) {
    // Deixa a IA atender e devolver o paciente para a etapa correta do cancelamento
    await aiAssistCancel({ from, userText });
    return; // encerra este turno sem quebrar o modo "cancel"
  }
}

    // 3) GATE: só seguimos se tiver TELEFONE ou NOME; data/hora sozinha não basta
if (!ctx.phone && !ctx.name) {
  // o paciente mandou apenas data/hora ou nada útil → peça identidade
  await sendText({
    to: from,
    text:
      "Para localizar com segurança, me envie **Telefone** (DDD + número) **e/ou** **Nome completo**.\n" +
      "Se souber, **data e horário** também me ajudam (ex.: 26/09 09:00)."
  });
  return;
}

    // 4) Buscar eventos: identidade (Telefone e/ou Nome) é obrigatória; Data/Hora são filtros adicionais
if (!ctx.phone && !ctx.name) {
  await sendText({
    to: from,
    text:
      "Preciso de **Telefone** (DDD + número) **e/ou** **Nome completo** para localizar seu agendamento.\n" +
      "Se tiver, **data** e **horário** ajudam como filtros (ex.: 26/09 09:00)."
  });
  return;
}

let matches = [];
try {
   // Use telefone "fallback" só para ampliar a BUSCA;
  // no filtro final, só exigimos telefone se o paciente informou explicitamente.
  const phoneForFetch = ctx.phone || (normalizePhoneForLookup(conversations.get(from)?.lastKnownPhone) || "");
  const nameForLookup  = ctx.name  || "";

  // 4.1) Busca ampla por paciente no período
  const rawEvents = await findPatientEvents({
    phone: phoneForFetch,
    name:  nameForLookup,
    daysBack: 180,
    daysAhead: 365
  });

  // 4.2) Filtra PRIMEIRO pela identidade (telefone/nome)
  const idFilter = { phone: (ctx.phone || ""), name: nameForLookup };
  let filtered = rawEvents.filter(ev => eventMatchesIdentity(ev, idFilter));


  // 4.3) Se veio data/hora, aplicar como filtros ADICIONAIS
  if (ctx.dateISO) {
    const dayStart = new Date(ctx.dateISO);
    const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    filtered = filtered.filter(ev => {
      const dt = ev.startISO ? new Date(ev.startISO) : null;
      if (!dt) return false;
      if (dt < dayStart || dt >= dayEnd) return false;

      if (ctx.timeHHMM) {
        const hh = String(dt.getHours()).padStart(2, "0");
        const mi = String(dt.getMinutes()).padStart(2, "0");
        const hhmm = `${hh}:${mi}`;
        // tolerância de 15 min
        if (hhmm !== ctx.timeHHMM) {
          const target = new Date(`${dayStart.toISOString().slice(0,10)}T${ctx.timeHHMM}:00`);
          const diff = Math.abs(dt.getTime() - target.getTime());
          if (diff > 15 * 60 * 1000) return false;
        }
      }
      return true;
    });
  }

  matches = filtered;
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
      await sendText({
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
      await sendText({
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

  await sendText({
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
  await sendText({
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

    await sendText({ to: from, text: cancelText });
// --- PREFILL para reagendamento após cancelamento ---
try {
  const ev = ctx?.chosenEvent || {};
  const convPrefill = ensureConversation(from);

  // Telefones e nomes extraídos do evento (helpers já existem no arquivo)
  const evPhones = extractPhonesFromEvent?.(ev) || [];
  const evNames  = extractNamesFromEvent?.(ev)  || [];

  if (evNames.length && !convPrefill.patientName) {
    convPrefill.patientName = toTitleCase(evNames[0]);
  }
  if (evPhones.length) {
    convPrefill.lastKnownPhone = normalizePhoneForLookup(evPhones[0]);
  }

  // Modalidade gravada como “nota” no histórico para a IA reaproveitar
  const prevMod = ev?.extendedProperties?.private?.modality;
  if (prevMod) appendMessage(from, "assistant", `Modalidade: ${prevMod}`);
} catch {}
// --- FIM PREFILL ---

    // 9) Se era remarcar, oferecer horários (com "opção N")
    const shouldReschedule = convMem.after === "schedule";
    convMem.mode = null;
    convMem.after = null;

    if (shouldReschedule) {
      const slots = await listAvailableSlots({
        fromISO: new Date().toISOString(),
        days: 14,
        limit: SLOTS_PAGE_SIZE
      });

      let msg;
      if (!slots.length) {
        msg = "Cancelamento concluído. Vamos remarcar? Não encontrei horários nos próximos dias. " +
              "Se preferir, me diga uma **data específica** (ex.: 24/09).";
      } else {
        const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
        msg = msg = "Cancelamento concluído, {{nome}}. Vamos remarcar agora. Seguem as opções:\n" + 
          linhas +
              '\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").\n' +
              'Se quiser ver **mais opções**, responda: **mais**.';
        convMem.lastSlots = slots;
        convMem.slotCursor = { fromISO: new Date().toISOString(), page: 1 };
        convMem.updatedAt = Date.now();
      }
      // registra no histórico e envia a lista para permitir “opção N” e “N”
appendMessage(from, "assistant", msg);
await sendText({ to: from, text: msg });

// evita a IA relistar horários logo em seguida (apenas neste turno)
const c = ensureConversation(from);
c.justPickedOption = true;
// libera a autolista novamente após 1,5s (não mexe no comportamento futuro)
setTimeout(() => {
  const c2 = getConversation(from);
  if (c2) c2.justPickedOption = false;
}, 1500);

    }

    return; // não deixa cair em outras regras
  }
}

// === ATALHO: "opção N" + "mais" (somente fora do modo cancelamento) ===
try {
  const convMem = getConversation(from);
  if (convMem?.mode === "cancel") {
    // ignorar durante cancelamento
  } else {
    const txt = (userText || "").trim().toLowerCase();

    // Paginação "mais"
    if (txt === "mais" || txt === "ver mais" || txt === "mais opções") {
      const cursor = convMem?.slotCursor || { fromISO: new Date().toISOString(), page: 1 };
      const base = new Date(cursor.fromISO);
      const nextFrom = new Date(base.getTime() + cursor.page * 7 * 86400000).toISOString();

      const more = await listAvailableSlots({ fromISO: nextFrom, days: MORE_SLOTS_DAYS, limit: SLOTS_PAGE_SIZE });
      const weekdayOnly = (more || []).filter(s => !isWeekend(s.startISO)).slice(0, SLOTS_PAGE_SIZE);
      if (!weekdayOnly.length) {
        await sendText({
          to: from,
          text: "Sem mais horários nesta janela. Se preferir, diga uma **data específica** (ex.: 30/09) ou peça outro dia da semana (ex.: \"próxima quinta\")."
        });
      } else {
        const linhas = weekdayOnly.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
        await sendText({
          to: from,
          text: "Aqui vão **mais opções**:\n" + linhas + '\n\nResponda com **opção N** ou informe **data e horário**.'
        });
        const convUpd = ensureConversation(from);
        convUpd.lastSlots = weekdayOnly;
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
        await sendText({
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
      const convFlag = ensureConversation(from);
convFlag.justPickedOption = true; // evita autolista no mesmo turno
  // evita relistar/repensar a mesma página de opções no próximo turno
  const convUpd = ensureConversation(from);
  convUpd.lastSlots = [];

      // segue o fluxo normal (sem return)
    }
  }
} catch (e) {
  console.error("[option-pick] erro:", e?.message || e);
}

    safeLog("INBOUND", req.body);

    // === PICK NUMÉRICO GLOBAL (antes de datas) ===
{
  const conv = getConversation(from);
  const pure = (userText || "").trim().replace(/[^\d]/g, "");
  if (pure && /^\d{1,2}$/.test(pure) && Array.isArray(conv?.lastSlots) && conv.lastSlots.length) {
    const idx = Number(pure) - 1;
    const chosen = conv.lastSlots[idx];
    if (chosen) {
      const dt = new Date(chosen.startISO);
      const tz = process.env.TZ || "America/Sao_Paulo";
      const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(dt).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
      userText = `Quero agendar nesse horário: ${fmt.day}/${fmt.month} ${fmt.hour}:${fmt.minute}`;
      ensureConversation(from).justPickedOption = true;
      // não limpamos lastSlots aqui (mantém robusto se o provedor repetir evento)
    }
  }
}
// === DATETIME LIVRE: "quarta dia 01/10 11:00", "qua 01/10 11:00", "01/10 11:00" ===
try {
  // não roubar o foco quando ainda estamos no modo de cancelamento
  if ((getConversation(from)?.mode || null) !== "cancel") {
    const raw = String(userText || "");
    const lower = raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
// --- [INTERCEPTOR DE PERÍODOS GENÉRICOS] ---
const genericPeriod = /\b(novembro|dezembro|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|ano que vem|mês que vem|proximo ano|próximo ano)\b/i;

if (genericPeriod.test(lower)) {
  // Não enviar lista automática aqui — deixar a IA conduzir
  const conv = ensureConversation(from);
  conv.awaitingSpecificDate = true; // flag para IA saber que precisa guiar

  await sendText({
    to: from,
    text: "Entendi! 😊 Você poderia me dizer um **dia e horário específico** que prefere nesse período? (Ex.: \"15 de novembro às 14h\")"
  });

  return; // 🔥 Interrompe o fluxo normal aqui
}
// --- [FIM DO INTERCEPTOR] ---

    // 1) Padrão: DD/MM[(/YYYY)] + HH:MM  (aceita "11h00" também)
    let m = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+(\d{1,2})(?::|h)(\d{2})\b/);

    // 2) Padrão: (quarta|qua|seg|...) ["dia"] DD/MM[(/YYYY)] HH:MM
    if (!m) {
      const WK = "(?:segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|seg|ter|qua|qui|sex|sab|dom)";
      const re = new RegExp(
        `\\b${WK}\\b(?:\\s*feira)?(?:\\s*d[ia]{1,2})?\\s*(\\d{1,2})[\\/\\-](\\d{1,2})(?:[\\/\\-](\\d{2,4}))?\\s*(\\d{1,2})(?::|h)(\\d{2})\\b`,
        "i"
      );
      m = lower.match(re);
    }

    if (m) {
      const dd = String(m[1]).padStart(2, "0");
      const mm = String(m[2]).padStart(2, "0");
      const yyyy =
        m[3] ? (String(m[3]).length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date().getFullYear();
      const hh = String(m[4]).padStart(2, "0");
      const mi = String(m[5]).padStart(2, "0");

      // validação simples: não permitir passado
      const whenISO = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00`;
      const when = new Date(whenISO);
      if (Number.isNaN(when.getTime())) {
        // deixa seguir o fluxo normal (IA/relativos) se não der pra parsear
      } else if (when.getTime() < Date.now()) {
        await sendText({
          to: from,
          text:
            "Datas/horários no passado não podem ser agendados. Diga um **dia e horário a partir de agora** (ex.: 01/10 11:00) ou peça **opções**."
        });
        return;
      } else {
        // Normaliza para o formato que o fluxo já entende
        userText = `Quero agendar nesse horário: ${dd}/${mm} ${hh}:${mi}`;
        const conv = ensureConversation(from);
        conv.justPickedOption = true; 
        
        // evita relistar automaticamente neste turno
        // Guarda o horário ISO escolhido para a IA usar na confirmação
try {
  const conv = ensureConversation(from);
  conv.pendingRescheduleISO = whenISO;   // ex.: "2025-10-01T11:00:00"
  conv.updatedAt = Date.now();
} catch {}

        
        // (não damos return: deixamos o fluxo de agendamento existente continuar)
      }
    }
  }
} catch (e) {
  console.error("[free-datetime-parse] erro:", e?.message || e);
}

    // === RELATIVOS: hoje / amanhã / depois de amanhã / ontem ===
try {
  if ((getConversation(from)?.mode || null) !== "cancel") {
    const raw = String(userText || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    const saysHoje   = /\bhoje\b/.test(raw);
    const saysAmanha = /\bamanha\b/.test(raw);
    const saysDpsA   = /\bdepois\s+de\s+amanha\b/.test(raw);
    const saysOntem  = /\bontem\b/.test(raw);

    if (saysHoje || saysAmanha || saysDpsA || saysOntem) {
      const tz = process.env.TZ || "America/Sao_Paulo";
      const now = new Date();
      const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const today0 = startOf(now);

      let targetDate = startOf(now);
      if (saysAmanha)   targetDate = new Date(today0.getTime() + 1 * 86400000);
      if (saysDpsA)     targetDate = new Date(today0.getTime() + 2 * 86400000);
      if (saysOntem)    targetDate = new Date(today0.getTime() - 1 * 86400000);

      // 1) "ontem" => não permite passado
      if (saysOntem || targetDate.getTime() < today0.getTime()) {
        await sendText({
          to: from,
          text: "Datas que já passaram não podem ser agendadas. Me diga uma **data a partir de hoje** (ex.: 24/09), ou peça por um dia da semana (ex.: \"próxima quinta\")."
        });
        return;
      }

      // 2) Sábado/domingo → sem expediente
      const dow = targetDate.getDay(); // 0=dom, 6=sáb
      if (dow === 6 || dow === 0) {
        const lbl = dow === 6 ? "sábado" : "domingo";
        await sendText({
          to: from,
          text: `No **${lbl}** não temos expediente. Posso te enviar **opções na segunda-feira** ou em outro dia que você preferir.`
        });
        return;
      }

      // 3) Hoje/agora → se "hoje", listar a partir de agora; senão, o dia todo
      const fromISO = saysHoje ? now.toISOString() : targetDate.toISOString();
      const slots = await listAvailableSlots({ fromISO, days: saysHoje ? 1 : 1, limit: SLOTS_PAGE_SIZE });

      const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" })
        .formatToParts(targetDate).reduce((a,p)=> (a[p.type]=p.value, a), {});
      const ddmm = `${fmt.day}/${fmt.month}`;

      if (!slots.length) {
        await sendText({
          to: from,
          text: `Para **${ddmm}** não encontrei horários livres. Posso te enviar alternativas próximas dessa data ou procurar outro dia.`
        });
      } else {
        const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
        await sendText({
          to: from,
          text: `Opções para **${ddmm}**:\n${linhas}\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").`
        });
        const convMem = ensureConversation(from);
        convMem.lastSlots = slots;
        convMem.updatedAt = Date.now();
      }
      return;
    }
  }
} catch (e) {
  console.error("[relative-days] erro:", e?.message || e);
}

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
      // GUARDAS: passado e fim de semana sem expediente
const now = new Date();
const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
if (targetDate.getTime() < today0.getTime()) {
  const tz = process.env.TZ || "America/Sao_Paulo";
  const fmt = new Intl.DateTimeFormat("pt-BR",{timeZone:tz,day:"2-digit",month:"2-digit"})
    .formatToParts(targetDate).reduce((a,p)=> (a[p.type]=p.value, a), {});
  const ddmm = `${fmt.day}/${fmt.month}`;
  await sendText({
    to: from,
    text: `**${ddmm}** já passou. Me diga uma data **a partir de hoje** (ex.: 24/09) ou peça por um dia da semana (ex.: "próxima quinta").`
  });
  return;
}
const dow = targetDate.getDay(); // 0=dom, 6=sáb
if (dow === 6 || dow === 0) {
  const lbl = dow === 6 ? "sábado" : "domingo";
  await sendText({
    to: from,
    text: `No **${lbl}** não temos expediente. Posso procurar horários na **segunda-feira** ou outro dia que prefira.`
  });
  return;
}

      // Listar opções deste dia
      const slots = await listAvailableSlots({
        fromISO: toISOStart(targetDate),
        days: 1,
        limit: SLOTS_PAGE_SIZE
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
  `Para **${ddmm}** não encontrei horários livres.\n` +
  `Posso te enviar alternativas próximas dessa data ou procurar outra data que você prefira.`;
        appendMessage(from, "assistant", msg);
        await sendText({ to: from, text: msg });
      } else {
        const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`);
        const msg =
          `Claro, seguem as opções para **${ddmm}**:\n` +
          linhas.join("\n") +
          `\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").`;
        appendMessage(from, "assistant", msg);
        await sendText({ to: from, text: msg });
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
        // Evita autolistar neste turno (senão a IA promete horários e relista)
ensureConversation(from).justPickedOption = true;
      } else {
        // Só a DATA -> listar horários desse dia
        const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        // GUARD: data passada não pode
const today0 = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 0,0,0,0);
if (dayStart.getTime() < today0.getTime()) {
  await sendText({
    to: from,
    text: "Essa data já passou. Por favor, informe **uma data a partir de hoje** (ex.: 24/09)."
  });
  return;
}

        const slots = await listAvailableSlots({
          fromISO: dayStart.toISOString(),
          days: 1,
          limit: SLOTS_PAGE_SIZE
        });

        const convMem = ensureConversation(from);
        convMem.lastSlots = slots;
        convMem.updatedAt = Date.now();

        const { name } = extractPatientInfo({ payload: p, phone: from, conversation: getConversation(from) });

        if (!slots.length) {
         const msg =
  `Para **${dd}/${mm}** não encontrei horários livres.\n` +
  `Posso te enviar alternativas próximas dessa data ou procurar outra data que você prefira.`;
          appendMessage(from, "assistant", msg);
          await sendText({ to: from, text: msg });
        } else {
          const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`);
          const msg =
            `Claro, escolha uma dentre as opções para **${dd}/${mm}** que seguem abaixo:\n` +
            linhas.join("\n") +
            `\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").`;
          appendMessage(from, "assistant", msg);
          await sendText({ to: from, text: msg });
        }
        return; // já respondemos com as opções do dia solicitado
      }
    }
  } catch (e) {
    console.error("[future-date] erro:", e?.message || e);
  }
}
{ /* guard removido a pedido do Marcos: não enviamos mais o prompt padrão aqui */ }
// === VALIDADOR RÁPIDO DE "DATA + HORA" (mensagem de ajuda quando formato inválido) ===
try {
  const tz = process.env.TZ || "America/Sao_Paulo";
  const mDT = /(\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2})(?::|h)(\d{2})/i.exec(String(userText||""));
  if (mDT) {
    // Monta "dd/mm hh:mm" e valida com seu parser padrão
    const dd = mDT[1].padStart(2, "0");
    const mm = mDT[2].padStart(2, "0");
    const hh = mDT[3].padStart(2, "0");
    const mi = mDT[4].padStart(2, "0");

    const parsed = await parseCandidateDateTime(`${dd}/${mm} ${hh}:${mi}`, tz);
    if (!parsed || !parsed.found) {
      await sendText({
        to: from,
        text: 'Desculpe, não entendi o que falou. 😅\n' +
              'Tente no formato **"24/09 11:00"** (dia/mês e hora:minuto).'
      });
      return; // <- evita cair na IA/auto-lista com entrada inválida
    }
  }
} catch {}

    // Montagem de contexto para a IA
const conv = getConversation(from);
let composed;

// --- Hints invisíveis pra IA (não exibidos pro paciente) ---
const nowMs = Date.now();
const greetedAt = conv?.greetedAt || 0;
const justGreetedRecently = (nowMs - greetedAt) < 30 * 60 * 1000; // 30 min sem se reapresentar

const lastBookedAt = conv?.lastBookedAt || 0;
const justBookedRecently = (nowMs - lastBookedAt) < 2 * 60 * 1000; // 2 min sem pedir confirmação de novo

let systemHints = [];
if (justGreetedRecently) {
  systemHints.push("NÃO se reapresente. Continue a conversa de onde parou.");
}
if (justBookedRecently) {
  systemHints.push("O agendamento JÁ FOI confirmado no sistema. NÃO peça confirmação novamente; ofereça orientações pré-consulta ou ajuda extra.");
}
// Sempre que o paciente mudar de ideia (ex.: estava cancelando e quer remarcar), a IA deve acolher e redirecionar gentilmente SEM reiniciar a conversa.
systemHints.push("Se o paciente mudar de intenção (agendar ↔ cancelar ↔ remarcar ↔ tirar dúvida), acolha e redirecione para o fluxo correto, sem reiniciar e sem repetir apresentação.");
// Se acabou de escolher um horário (opção N ou "dd/mm hh:mm"), a IA deve conduzir a confirmação completa
try {
  const convSnap = getConversation(from);
  const pickedNow = !!(convSnap && convSnap.justPickedOption);
  const saidDirectPick = /^quero agendar nesse horário:/i.test(String(userText || ""));
  if (pickedNow || saidDirectPick) {
    systemHints.push(
      "AGORA conduza o REAGENDAMENTO: 1) confirme NOME COMPLETO, TELEFONE, IDADE, MODALIDADE e MOTIVO; " +
      "2) confirme o HORÁRIO escolhido; 3) finalize com a FRASE CABALÍSTICA exata " +
      "('Pronto! Sua consulta com a Dra. Jenifer está agendada para o dia DD/MM/AA, horário HH:MM.'). " +
      "Use 2 dígitos para o ano (AA) e horário em 24h. NÃO crie evento — apenas escreva a frase ao final."
    );

    // Passa o horário ISO escolhido como dica oculta (se existir)
    if (convSnap && convSnap.pendingRescheduleISO) {
      systemHints.push(`HORARIO_ESCOLHIDO_ISO=${convSnap.pendingRescheduleISO}`);
    }
  }
} catch {}

const hintsBlock = systemHints.length
  ? `\n\n[HINTS (NÃO MOSTRAR AO PACIENTE): ${systemHints.join(" ")}]`
  : "";

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
    `Responda de forma consistente com o histórico, mantendo o tom e as regras da clínica.` +
    hintsBlock; // <--- anexa os hints invisíveis
} else {
  composed = (userText || "") + hintsBlock; // conversa nova com hints
}

// === INTENÇÃO: "mais próximo" / "quando tem disponível"  =====================
{
  const t = (userText || "")
  .toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // sem acentos

// 1) “o mais próximo / primeira data / mais cedo possível”
const wantsNearest =
  /\b(mais\s*proxim[oa]|data\s*mais\s*proxim[oa]|primeir[oa]\s*(data|horario)|mais\s*cedo(\s*possivel)?)\b/.test(t);

// 2) “tem livre / quando tem / horários disponíveis / tem agenda”
const wantsAvailability =
  /\b(quando\s*tem\s*(livre|agenda|disponivel)|tem\s*(horario|agenda)|horarios?\s*disponiveis|quais\s*horarios|quando\s*(pode|daria))\b/.test(t);

// dispare a listagem se for qualquer uma das intenções acima
if (
   (wantsNearest || wantsAvailability) &&
   (getConversation(from)?.mode || null) !== "cancel" &&
   process.env.AVAIL_FAST_PATH !== "false"
 ) {
    const baseISO = new Date().toISOString();

    // pega próximos dias úteis, limitado à sua página
    const raw = await listAvailableSlots({ fromISO: baseISO, days: 7, limit: SLOTS_PAGE_SIZE });
    const slots = (raw || []).filter(s => {
      const dow = new Date(s.startISO).getDay(); // 0 dom, 6 sáb
      return dow !== 0 && dow !== 6;
    });

    if (!slots.length) {
      await sendText({
        to: from,
        text: "No momento não encontrei horários em dias úteis nos próximos dias. Se preferir, me diga uma data (ex.: 24/09)."
      });
    } else {
      const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
      const msg =
        "Claro, aqui vão as opções mais próximas:\n" +
        linhas +
        '\n\nResponda com **opção N** (ex.: "opção 3") ou digite **data e horário** (ex.: "24/09 14:00").';

      const convNow = ensureConversation(from);
      convNow.lastSlots = slots;
      convNow.slotCursor = { fromISO: baseISO, page: 1 };
      convNow.updatedAt = Date.now();

      appendMessage(from, "assistant", msg);
      await sendText({ to: from, text: msg });
    }
    return; // corta o fluxo aqui para não vir a mensagem genérica da IA
  }
}
// ============================================================================ 

    // Resposta da secretária (IA)
    const answer = await askCristina({ userText: composed, userPhone: String(from) });

    // === SE A IA MENCIONAR QUE VAI ENVIAR HORÁRIOS, ANEXA A LISTA GERADA DO CALENDÁRIO ===
let finalAnswer = answer;
try {
  const convNow = ensureConversation(from);
  const modeNow = getConversation(from)?.mode || null;

  // dispare somente quando a IA PROMETER enviar horários
  const shouldList =
  /vou te enviar os hor[aá]rios livres/i.test(answer || "") ||
  /perfeito,\s*j[aá]\s*te mando as op[cç][oõ]es na mensagem a seguir/i.test(answer || "");

  // não autolistar se acabou de escolher "opção N" ou se está em modo cancelamento
  const skipAuto = Boolean(convNow.justPickedOption) || modeNow === "cancel";

  if (shouldList && !skipAuto) {
    const baseISO = new Date().toISOString();
    const raw = await listAvailableSlots({ fromISO: baseISO, days: 7, limit: SLOTS_PAGE_SIZE });


    // filtra fim de semana aqui mesmo (sem depender de helper externo)
    const slots = (raw || []).filter(s => {
      const d = new Date(s.startISO);
      const dow = d.getDay(); // 0=domingo, 6=sábado
      return dow !== 0 && dow !== 6;
    });

    if (!slots.length) {
      finalAnswer =
        "No momento não encontrei horários **em dias úteis** nos próximos dias.\n" +
        'Se preferir, me diga uma **data específica** (ex.: "24/09").';
    } else {
      const linhas = slots.map((s, i) => `${i + 1}) ${s.dayLabel} ${s.label}`).join("\n");
      finalAnswer =
        "Claro, escolha uma dentre as opções mais próximas que seguem abaixo:\n" +
        linhas +
        '\n\nVocê pode responder com **opção N** (ex.: "opção 3") ou digitar **data e horário** (ex.: "24/09 14:00").';

      convNow.lastSlots = slots;
      convNow.slotCursor = { fromISO: baseISO, page: 1 };
      convNow.updatedAt = Date.now();
    }
  }

  // se havia acabado de escolher "opção N", limpamos a flag depois de responder
  if (convNow.justPickedOption) convNow.justPickedOption = false;

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
  await sendText({ to: from, text: msg });
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
            // Marca que acabamos de agendar (anti re-confirmação pela IA nos próximos minutos)
try {
  const c = ensureConversation(from);
  c.lastBookedAt = Date.now();
} catch {}


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
  await sendText({ to: from, text: finalAnswer });
  // Marca que a Cristina já se apresentou (anti-reapresentação)
// Detecta frases típicas de apresentação; ajuste se quiser mais padrões.
try {
  const introRegex = /\b(Secret[aá]ria\s+Cristina|sou\s+a\s+Cristina|me\s+chamo\s+Cristina)\b/i;
  if (finalAnswer && introRegex.test(finalAnswer)) {
    const c = ensureConversation(from);
    if (!c.greetedAt) c.greetedAt = Date.now();
  }
} catch {}

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
