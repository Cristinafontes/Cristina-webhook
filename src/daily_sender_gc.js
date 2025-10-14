// src/daily_sender_gc.js
// Worker: lê do Google Calendar e envia lembretes via Z-API (sem banco)

import axios from "axios";
import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { google } from "googleapis";

dayjs.extend(utc);
dayjs.extend(timezone);

// ====== CONFIG ======
const TZ = process.env.TZ || "America/Sao_Paulo";

const REMINDER_DAYS_BEFORE = parseInt(process.env.REMINDER_DAYS_BEFORE || "1", 10);
const REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || "9", 10);
const REMINDER_MINUTE = parseInt(process.env.REMINDER_MINUTE || "0", 10);

const REMINDER_MESSAGE =
  process.env.REMINDER_MESSAGE ||
  'Olá {{nome}}, lembrando da sua consulta {{modalidade}} no dia {{data}} às {{hora}}. ' +
  'Se estiver tudo certo, responda "Confirmo". Se precisar remarcar, digite "Remarcar".';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
// Marcar no evento que já enviou (idempotência simples)
const CALENDAR_MARK_SENT = (process.env.GOOGLE_CALENDAR_MARK_SENT || "1") === "1";

// Z-API
const ZAPI_BASE_URL = process.env.ZAPI_BASE_URL || "https://api.z-api.io";
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || process.env.ZAPI_ACCOUNT_TOKEN;

// Ritmo humano / logs
const HUMAN_DELAY_MIN_MS = parseInt(process.env.HUMAN_DELAY_MIN_MS || "2000", 10);
const HUMAN_DELAY_MAX_MS = parseInt(process.env.HUMAN_DELAY_MAX_MS || "6000", 10);
const REMINDER_BATCH_LIMIT = parseInt(process.env.REMINDER_BATCH_LIMIT || "300", 10);
const ENABLE_LOGS = (process.env.REMINDER_VERBOSE_LOGS || "true").toLowerCase() === "true";

// ====== GOOGLE AUTH (OAuth com refresh token) ======
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ====== HELPERS ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const humanDelay = () => rand(HUMAN_DELAY_MIN_MS, HUMAN_DELAY_MAX_MS);

function targetDayBoundsTZ(daysBefore) {
  const startLocal = dayjs().tz(TZ).add(daysBefore, "day").startOf("day");
  const endLocal = startLocal.endOf("day");
  return {
    startISO: startLocal.toDate().toISOString(),
    endISO: endLocal.toDate().toISOString(),
    prettyDate: startLocal.format("DD/MM/YYYY"),
  };
}

function normalizePhoneToBR(phoneRaw) {
  if (!phoneRaw) return null;
  const digits = phoneRaw.replace(/\D+/g, "");
  if (digits.startsWith("55")) return digits;
  if (digits.length >= 10 && digits.length <= 11) return "55" + digits;
  return null;
}

// tenta extrair telefone do evento
function extractPhone(ev) {
  const priv = ev.extendedProperties?.private || {};
  if (priv.patientPhone) {
    const p = normalizePhoneToBR(String(priv.patientPhone));
    if (p) return p;
  }
  const desc = ev.description || "";
  const m1 = desc.match(/\b(?:\+?55)?\D?(\d{2})\D?\d{4,5}\D?\d{4}\b/);
  if (m1) {
    const p = normalizePhoneToBR(m1[0]);
    if (p) return p;
  }
  if (Array.isArray(ev.attendees)) {
    for (const at of ev.attendees) {
      const p = normalizePhoneToBR(at?.comment || at?.displayName || at?.email || "");
      if (p) return p;
    }
  }
  return null;
}

function inferModality(ev) {
  const priv = ev.extendedProperties?.private || {};
  if (priv.modality) return String(priv.modality);
  const hay = `${ev.summary || ""} ${ev.description || ""}`.toLowerCase();
  if (hay.includes("pré-anest")) return "Pré-anestésico";
  if (hay.includes("anest")) return "Anestesia";
  if (hay.includes("dor")) return "Medicina da Dor";
  return "consulta";
}

function fillTemplate(tpl, vars) {
  return tpl
    .replace(/{{\s*nome\s*}}/gi, vars.nome || "")
    .replace(/{{\s*data\s*}}/gi, vars.data || "")
    .replace(/{{\s*hora\s*}}/gi, vars.hora || "")
    .replace(/{{\s*modalidade\s*}}/gi, vars.modalidade || "")
    .replace(/{{\s*local\s*}}/gi, vars.local || "");
}

async function sendViaZapiText(phoneE164, message) {
  const url = `${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  const payload = { phone: phoneE164, message };
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  return data;
}

function alreadyMarkedSent(ev, templateKey) {
  const priv = ev.extendedProperties?.private || {};
  return priv?.[templateKey] === "1";
}

async function markSentOnEvent(ev, templateKey) {
  if (!CALENDAR_MARK_SENT) return;
  try {
    const priv = { ...(ev.extendedProperties?.private || {}) };
    priv[templateKey] = "1";
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: ev.id,
      requestBody: {
        extendedProperties: {
          ...ev.extendedProperties,
          private: priv,
        },
      },
    });
  } catch (e) {
    if (ENABLE_LOGS) console.warn("[WARN] Falha ao marcar reminder_sent:", e?.message || e);
  }
}

// ====== CORE ======
async function fetchEventsForTargetDay() {
  const { startISO, endISO } = targetDayBoundsTZ(REMINDER_DAYS_BEFORE);
  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
  });
  return res.data.items || [];
}

async function runDailyReminder() {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) {
    console.error("[ERRO] Faltam ZAPI_INSTANCE_ID/ZAPI_INSTANCE ou ZAPI_TOKEN/ZAPI_ACCOUNT_TOKEN.");
    return;
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.error("[ERRO] Faltam GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.");
    return;
  }

  const templateKey = `reminder_gc_d${REMINDER_DAYS_BEFORE}_h${REMINDER_HOUR}m${REMINDER_MINUTE}`;
  const events = await fetchEventsForTargetDay();

  if (ENABLE_LOGS) {
    const when = dayjs().tz(TZ).format("DD/MM/YYYY HH:mm");
    console.log(`[INFO] ${when} — ${events.length} eventos no alvo (${templateKey}).`);
  }

  let sent = 0;

  for (const ev of events) {
    if (sent >= REMINDER_BATCH_LIMIT) break;
    if (ev.status === "cancelled") continue;
    if (alreadyMarkedSent(ev, templateKey)) {
      if (ENABLE_LOGS) console.log(`[SKIP] Já enviado: ${ev.summary || ev.id}`);
      continue;
    }

    const start = ev.start?.dateTime || ev.start?.date;
    const startLocal = dayjs(start).tz(TZ);
    const nome = (ev.summary || "").trim() || "Paciente";
    const telefone = extractPhone(ev);
    const modalidade = inferModality(ev);
    const local = ev.location || "";

    if (!telefone) {
      if (ENABLE_LOGS) console.warn(`[SKIP] Sem telefone: ${nome} (${ev.id})`);
      continue;
    }

    const vars = {
      nome,
      data: startLocal.format("DD/MM/YYYY"),
      hora: ev.start?.date ? "" : startLocal.format("HH:mm"),
      modalidade,
      local,
    };

    const message = fillTemplate(REMINDER_MESSAGE, vars);

    try {
      await sleep(humanDelay());
      await sendViaZapiText(telefone, message);
      sent++;
      if (ENABLE_LOGS) console.log(`[OK] ${telefone} | ${nome} | ${vars.data} ${vars.hora}`);
      await markSentOnEvent(ev, templateKey);
    } catch (err) {
      console.error(`[ERRO] ${telefone} | ${nome} | ${vars.data} ${vars.hora} ->`,
        err?.response?.data || err?.message || err);
    }
  }

  if (ENABLE_LOGS) console.log(`[DONE] Enviados: ${sent}`);
}

// ====== CRON (worker dedicado) ======
const cronExpr = `${REMINDER_MINUTE} ${REMINDER_HOUR} * * *`;

if (process.env.RUN_NOW === "1") {
  runDailyReminder()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log(`[INIT] Worker GC armado: "${cronExpr}" (${TZ}).`);
  cron.schedule(cronExpr, () => {
    runDailyReminder().catch((e) => console.error("[FATAL RUN]", e));
  }, { timezone: TZ });
}
