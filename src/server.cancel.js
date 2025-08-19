import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import { cancelCalendarEventByDateTime } from "./google.cancel.esm.js";
import { parseCandidateDateTime } from "./utils.esm.js";

// Load .env if running locally (Railway injects envs automatically)
dotenv.config();

const app = express();
app.use(express.json());
app.use(helmet());
app.use(compression());
app.use(cors({ origin: "*"}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});
app.use(limiter);

// Health check
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "cristina-cancel-only", now: new Date().toISOString() });
});

/**
 * Endpoint simples para cancelar a consulta a partir da mensagem ENVIADA ao paciente
 * pelo seu bot/atendente virtual.
 *
 * Como usar:
 *  POST /cancel-from-message
 *  { "text": "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia 19/08/25, horário 10:00." }
 *
 * O servidor só tenta cancelar se encontrar a palavra "cancelada" (case-insensitive).
 * Caso contrário, não faz nada (idempotente) e retorna 200.
 */
app.post("/cancel-from-message", async (req, res) => {
  try {
    const text = String(req.body?.text || "");
    if (!text) {
      return res.status(400).json({ ok: false, error: "Campo 'text' obrigatório." });
    }

    const isCancel = /cancelad[ao]/i.test(text);
    if (!isCancel) {
      return res.status(200).json({ ok: true, skipped: true, reason: "mensagem não é de cancelamento" });
    }

    // Extrai data/hora no formato brasileiro (dd/mm/aa ou dd/mm/aaaa, HH:mm ou HHh)
    const parsed = parseCandidateDateTime(text, process.env.TZ || "America/Sao_Paulo");
    if (!parsed.found) {
      return res.status(400).json({ ok: false, error: "Não consegui entender a data/horário na mensagem." });
    }

    const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

    const result = await cancelCalendarEventByDateTime({
      calendarId,
      startISO: parsed.startISO,
      endISO: parsed.endISO,
    });

    if (result.cancelled) {
      return res.status(200).json({
        ok: true,
        cancelled: true,
        cancelledEventSummary: result.summary,
        cancelledEventId: result.eventId,
        timeWindow: { timeMin: result.timeMin, timeMax: result.timeMax },
      });
    } else {
      return res.status(404).json({
        ok: false,
        cancelled: false,
        error: "Nenhum evento compatível encontrado no horário informado.",
        timeWindow: { timeMin: result.timeMin, timeMax: result.timeMax },
      });
    }
  } catch (err) {
    console.error("[/cancel-from-message] Error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Porta padrão 8081 para não conflitar com seu server principal (8080)
const PORT = Number(process.env.PORT || 8081);
app.listen(PORT, () => {
  console.log(`[cancel-server] Listening on port ${PORT}`);
});
