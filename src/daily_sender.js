// src/daily_sender.js
// Envia lembretes automáticos 1x/dia via Z-API (ES Modules)

import axios from "axios";
import cron from "node-cron";
import { Pool } from "pg";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// ===== Configs editáveis por variável de ambiente =====
const TZ = "America/Sao_Paulo";

const REMINDER_DAYS_BEFORE = parseInt(process.env.REMINDER_DAYS_BEFORE || "2", 10);
const REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || "9", 10);
const REMINDER_MINUTE = parseInt(process.env.REMINDER_MINUTE || "0", 10);

const REMINDER_MESSAGE =
  process.env.REMINDER_MESSAGE ||
  'Olá {{nome}}, lembrando da sua consulta {{modalidade}} no dia {{data}} às {{hora}}. ' +
  'Se estiver tudo certo, responda "Confirmo". Se precisar remarcar, digite "Remarcar".';

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
// Opcional: se quiser sobrepor a base
const ZAPI_BASE_URL = process.env.ZAPI_BASE_URL || "https://api.z-api.io";

const HUMAN_DELAY_MIN_MS = parseInt(process.env.HUMAN_DELAY_MIN_MS || "2000", 10);
const HUMAN_DELAY_MAX_MS = parseInt(process.env.HUMAN_DELAY_MAX_MS || "6000", 10);
const BATCH_LIMIT = parseInt(process.env.REMINDER_BATCH_LIMIT || "300", 10);
const ENABLE_LOGS = (process.env.REMINDER_VERBOSE_LOGS || "true").toLowerCase() === "true";

// ===== Banco (mesmo Postgres do seu app) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const humanDelay = () => rand(HUMAN_DELAY_MIN_MS, HUMAN_DELAY_MAX_MS);

function fillTemplate(tpl, vars) {
  return tpl
    .replace(/{{\s*nome\s*}}/gi, vars.nome || "")
    .replace(/{{\s*data\s*}}/gi, vars.data || "")
    .replace(/{{\s*hora\s*}}/gi, vars.hora || "")
    .replace(/{{\s*modalidade\s*}}/gi, vars.modalidade || "")
    .replace(/{{\s*local\s*}}/gi, vars.local || "");
}

function formatVars(appointment) {
  const start = dayjs(appointment.starts_at).tz(TZ);
  return {
    nome: appointment.patient_name || "",
    data: start.format("DD/MM/YYYY"),
    hora: start.format("HH:mm"),
    modalidade: appointment.modality || "consulta",
    local: appointment.location || "",
    telefone: appointment.phone_e164,
  };
}

async function ensureOutboxTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS outbox_templates (
      id BIGSERIAL PRIMARY KEY,
      appointment_id UUID NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      template_key TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_templates_appointment ON outbox_templates(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_templates_template_key ON outbox_templates(template_key);
  `;
  await pool.query(sql);
}

function targetDateRangeUTC(daysBefore) {
  const nowLocal = dayjs().tz(TZ);
  const startLocal = nowLocal.add(daysBefore, "day").startOf("day");
  const endLocal = nowLocal.add(daysBefore, "day").endOf("day");
  return { startUTC: startLocal.utc().toISOString(), endUTC: endLocal.utc().toISOString() };
}

async function fetchAppointmentsForReminder(daysBefore, limit, templateKey) {
  const { startUTC, endUTC } = targetDateRangeUTC(daysBefore);
  const sql = `
    SELECT a.*
    FROM appointments a
    WHERE a.status = 'scheduled'
      AND a.starts_at >= $1
      AND a.starts_at <= $2
      AND COALESCE(a.phone_e164, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM outbox_templates o
        WHERE o.appointment_id = a.id
          AND o.template_key = $3
      )
    ORDER BY a.starts_at ASC
    LIMIT $4
  `;
  const { rows } = await pool.query(sql, [startUTC, endUTC, templateKey, limit]);
  return rows;
}

async function recordOutbox(appointmentId, templateKey, status, messageId = null, error = null) {
  const sql = `
    INSERT INTO outbox_templates (appointment_id, template_key, status, message_id, error)
    VALUES ($1, $2, $3, $4, $5)
  `;
  await pool.query(sql, [appointmentId, templateKey, status, messageId, error]);
}

async function sendViaZapiText(phoneE164, message) {
  const url = `${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  const payload = { phone: phoneE164, message };
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  return data;
}

async function runDailyReminder() {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) {
    console.error("[ERRO] Faltam ZAPI_INSTANCE_ID ou ZAPI_TOKEN nas variáveis.");
    return;
  }

  await ensureOutboxTables();

  const templateKey = `reminder_d${REMINDER_DAYS_BEFORE}_h${REMINDER_HOUR}m${REMINDER_MINUTE}`;
  const appts = await fetchAppointmentsForReminder(REMINDER_DAYS_BEFORE, BATCH_LIMIT, templateKey);

  if (ENABLE_LOGS) {
    const now = dayjs().tz(TZ).format("DD/MM/YYYY HH:mm");
    console.log(`[INFO] ${now} — ${appts.length} lembretes para enviar (${templateKey}).`);
  }

  for (const a of appts) {
    const vars = formatVars(a);
    const msg = fillTemplate(REMINDER_MESSAGE, vars);

    try {
      await sleep(humanDelay());
      const result = await sendViaZapiText(vars.telefone, msg);
      const messageId = result?.messageId || result?.id || null;

      await recordOutbox(a.id, templateKey, "success", messageId, null);
      if (ENABLE_LOGS) {
        console.log(`[OK] ${vars.telefone} | ${vars.nome} | ${vars.data} ${vars.hora}`);
      }
    } catch (err) {
      const errText = err?.response?.data ? JSON.stringify(err.response.data) : String(err.message);
      await recordOutbox(a.id, templateKey, "error", null, errText);
      console.error(`[ERRO] ${vars.telefone} | ${vars.nome} | ${vars.data} ${vars.hora} -> ${errText}`);
    }
  }
}

// Monta o CRON diário (minuto hora * * *) no fuso de São Paulo
const cronExpr = `${REMINDER_MINUTE} ${REMINDER_HOUR} * * *`;

if (process.env.RUN_NOW === "1") {
  // Executa 1 vez e sai (para teste)
  runDailyReminder()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log(`[INIT] Lembrete diário armado: "${cronExpr}" (${TZ})`);
  cron.schedule(cronExpr, () => {
    runDailyReminder().catch((e) => console.error("[FATAL RUN]", e));
  }, { timezone: TZ });
}
