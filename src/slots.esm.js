// slots.esm.js
// Lista horários disponíveis checando o freebusy do Google Calendar e uma agenda opcional de bloqueios.
// Gera janelas de X minutos dentro do expediente configurado.

import { google } from "googleapis";
import { getBusyTimes } from "./utils.esm.js"; // usa util existente do projeto

// ===== ENV =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || "primary";
const BLOCK_CAL_ID  = process.env.GOOGLE_BLOCK_CALENDAR_ID || "";
const TZ            = process.env.TZ || "America/Sao_Paulo";

// === Helpers de fuso horário ===
// Sempre que formos formatar rótulos, usamos o TZ explicitamente.
function formatDow(d) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: TZ })
    .format(d)
    .replace(".", "");
}
function formatDate(d) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: TZ })
    .format(d);
}
function formatTime(d) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ })
    .format(d);
}

// Obtém o dia da semana (0=Dom..6=Sáb) respeitando o TZ
function getDowTZ(d) {
  const m = {
    "dom": 0, "seg": 1, "ter": 2, "qua": 3, "qui": 4, "sex": 5,
    "sab": 6, "sáb": 6
  };
  const k = formatDow(d).toLowerCase().slice(0,3);
  return (k in m) ? m[k] : new Date(d).getUTCDay();
}

// Constrói um ISO para o instante que corresponde ao horário local (TZ) pedido.
// Uso simples para BR sem DST: SP = UTC-3 (horário de Brasília atual).
function isoAt(dateLike, hhmm) {
  const d = new Date(dateLike);
  const [hh, mm] = String(hhmm).split(":").map(Number);
  // cria um UTC adicionando 3h (fuso de SP sem DST) para representar o local HH:MM
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), (hh ?? 0) + 3, mm ?? 0, 0, 0);
  return new Date(utc).toISOString();
}

// expediente por dia da semana (0=Dom,1=Seg,...)
let WORKING_HOURS = {};
try {
  WORKING_HOURS = JSON.parse(process.env.WORKING_HOURS_JSON || "{}");
} catch {
  WORKING_HOURS = {};
}

// Parâmetros
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60); // 60 por padrão
const BUFFER_MIN   = Number(process.env.BUFFER_MINUTES || 0);
const ADVANCE_MIN  = Number(process.env.ADVANCE_MIN_HOURS || 1) * 60;

// Autenticação Google
function getAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Faltam variáveis do Google (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN).");
  }
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

/**
 * Lista até N slots livres a partir de uma data (inclusive), olhando D dias pela frente.
 * @param {Object} params
 * @param {string} params.fromISO    ISO início da busca (padrão agora)
 * @param {number} params.days       Quantos dias olhar adiante (padrão 7)
 * @param {number} params.limit      Máximo de slots a retornar (padrão 10)
 * @returns Array<{startISO,endISO,label,dayLabel}>
 */
export async function listAvailableSlots({ fromISO, days = 7, limit = 100 } = {}) {
  // ponto de partida
  let from = fromISO ? new Date(fromISO) : new Date();

  // respeitar antecedência mínima (em horas)
  if (ADVANCE_MIN > 0) {
    from = new Date(from.getTime() + ADVANCE_MIN * 60000);
  }

  const auth = getAuth();
  const ids = [CALENDAR_ID];
  if (BLOCK_CAL_ID && BLOCK_CAL_ID !== CALENDAR_ID) ids.push(BLOCK_CAL_ID);

  const out = [];

  // varrer por dia
  for (let i = 0; i < days; i++) {
    // hoje + i dias
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);

    // ranges do expediente para o dia da semana correto no TZ
    const dow = getDowTZ(day);
    const ranges = WORKING_HOURS[String(dow)];
    if (!ranges || !ranges.length) continue;

    // busy para o "dia" (função util do projeto)
    const busy = await getBusyTimes(auth, ids, day);
    const busyN = (busy || []).map(b => ({
      start: b.start instanceof Date ? b.start : new Date(b.start),
      end:   b.end   instanceof Date ? b.end   : new Date(b.end),
    }));

    // gerar slots por faixa
    for (const [hhIni, hhFim] of ranges) {
      // monta instantes (UTC) equivalentes ao horário local no TZ (SP=UTC-3)
      let winStart = new Date(isoAt(day, hhIni));
      let winEnd   = new Date(isoAt(day, hhFim));

      // aplica buffer, se houver
      if (BUFFER_MIN > 0) {
        winStart = new Date(winStart.getTime() + BUFFER_MIN * 60000);
        winEnd   = new Date(winEnd.getTime()   - BUFFER_MIN * 60000);
      }

      const startMs = winStart.getTime();
      const endMs   = winEnd.getTime();

      for (let t = startMs; t < endMs; t += SLOT_MINUTES * 60000) {
        const start = new Date(t);
        const end   = new Date(t + SLOT_MINUTES * 60000);

        // última consulta não pode ultrapassar o fim da faixa
        if (end > winEnd) break;

        // respeita antecedência mínima
        if (start < from) continue;

        // conflito com busy?
        const overlap = busyN.some(b => !(end <= b.start || start >= b.end));
        if (overlap) continue;

        // labels com TZ
        const dowShort = formatDow(start);
        const dayLabel = dowShort.charAt(0).toUpperCase() + dowShort.slice(1, 3); // "Seg", "Ter", ...
        const label    = `${formatDate(start)} ${formatTime(start)}`;

        out.push({
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          dayLabel,
          label,
        });

        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
