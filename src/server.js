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

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

app.use(async (req, res, next) => {
  if (req.headers["content-type"]?.includes("application/json")) {
    try {
      const raw = await getRawBody(req);
      req.rawBody = raw;
      req.body = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  } else {
    next();
  }
});

app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "Cristina WhatsApp Webhook" }));
app.get("/webhook/gupshup", (_req, res) => res.status(200).send("ok"));
app.post("/webhook/gupshup", async (req, res) => {
  res.status(200).end();
  try {
    const eventType = req.body?.type;
    if (eventType !== "message") return;

    const p = req.body?.payload;
    const msgType = p?.type;
    const from = p?.sender?.phone || p?.source;
    if (!from) return;

    let userText = "";
    if (msgType === "text") userText = p?.payload?.text || "";
    else if (msgType === "button_reply" || msgType === "list_reply") userText = p?.payload?.title || p?.payload?.postbackText || "";
    else {
      await sendWhatsAppText({ to: from, text: "Por ora, consigo ler apenas mensagens de texto. Pode tentar novamente?" });
      return;
    }

    safeLog("INBOUND", req.body);
    const answer = await askCristina({ userText, userPhone: from });
    if (answer) await sendWhatsAppText({ to: from, text: answer });
  } catch (err) {
    console.error("ERR /webhook/gupshup:", err?.response?.data || err);
  }
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
