// utils.esm.js
export function parseCandidateDateTime(text, _tz = process.env.TIMEZONE || "America/Sao_Paulo") {
  if (!text) return { found: false };
  const re = /(\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)[^\d]{0,10}(\d{1,2})(?::?(\d{2}))?\s*(h|hs|horas|$)/i;
  const m = String(text).match(re);
  if (!m) return { found: false };

  const [_, dateRaw, hhRaw, mmRaw] = m;
  const [dStr, mStr, yStr] = dateRaw.split("/");
  const dd = parseInt(dStr, 10);
  const mm = parseInt(mStr, 10);
  let yyyy = yStr ? parseInt(yStr, 10) : new Date().getFullYear();
  if (yyyy < 100) yyyy += 2000;

  const HH = parseInt(hhRaw, 10);
  const MM = mmRaw ? parseInt(mmRaw, 10) : 0;

  if (!(dd >= 1 && dd <= 31) || !(mm >= 1 && mm <= 12) || !(HH >= 0 && HH <= 23) || !(MM >= 0 && MM <= 59)) {
    return { found: false };
  }

  const startUTC = new Date(Date.UTC(yyyy, mm - 1, dd, HH + 3, MM, 0, 0));
  const durMin = parseInt(process.env.APPT_DURATION_MINUTES || "60", 10);
  const endUTC = new Date(startUTC.getTime() + durMin * 60 * 1000);

  return { found: true, startISO: startUTC.toISOString(), endISO: endUTC.toISOString(), dd, mm, yyyy, HH, MM };
}

export function formatBRDate({ dd, mm, yyyy, HH, MM }) {
  const d = String(dd).padStart(2, "0");
  const m = String(mm).padStart(2, "0");
  const y = String(yyyy).slice(-2);
  const hh = String(HH).padStart(2, "0");
  const min = String(MM).padStart(2, "0");
  return { dmy: `${d}/${m}/${y}`, hm: `${hh}:${min}` };
}

export function normalizePhoneForTitle(phone) {
  if (!phone) return "";
  const m = String(phone).match(/\+?55?(\d{2})(\d{4,5})(\d{4})/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return String(phone).replace(/(\d{0,7})(\d{4})$/, "****$2");
}

export function extractPatientName(text) {
  if (!text) return null;
  const re = /(?:meu\s+nome\s+é|sou\s+o|sou\s+a|eu\s+sou)\s+([A-Za-zÀ-ÿ'`\-\s]{3,60})/i;
  const m = text.match(re);
  if (m) return m[1].trim().replace(/\s+/g, " ");
  return null;
}

export function detectIntent(text) {
  const t = String(text || "").toLowerCase();
  const isCancel = /(\bcancel|desmarc)/.test(t);
  const isCreate = /(agend|marc|confirm)/.test(t) && !isCancel;
  return { isCancel, isCreate };
}

export function parseModality(text) {
  const t = String(text || "").toLowerCase();
  if (/tele(medicina|consulta|atendimento|online|ví?deo)/.test(t)) return "telemedicina";
  if (/presencial|no consultório|na clinica|na clínica/.test(t)) return "presencial";
  return null;
}

export function isAffirmative(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(sim|s|ok|confirmo|pode|isso|confirmar|confere)/.test(t);
}

export function isNegative(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(nao|não|n|negativo|cancela|deixa)/.test(t);
}
