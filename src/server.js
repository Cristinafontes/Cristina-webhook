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

// --- Security & basics ---
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

// --- Tolerant body parser: JSON and x-www-form-urlencoded ---
// Some Gupshup sandbox deliveries come as application/x-www-form-urlencoded.
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
      // If payload is JSON string, parse it
      if (typeof body.payload === "string") {
        try {
          body.payload = JSON.parse(body.payload);
        } catch {
          /* ignore parse errors */
        }
      }
      // Gupshup also sends type at top level in form mode
      req.body = body;
    } else {
      // Accept silently other content-types
      req.body = {};
    }
    return next();
  } catch (e) {
    console.error("Parser error:", e);
    // Never block webhook delivery while debugging parser
    res.status(200).end();
  }
});

// --- Health endpoints & GET validators ---
app.get("/", (_req, res) =>
  res
    .status(200)
    .json({ ok: true, service: "Cristina WhatsApp Webhook" })
);

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/webhook/gupshup", (_req, res) => res.status(200).send("ok"));

// --- Shared inbound handler ---
async function handleInbound(req, res) {
  // Acknowledge immediately to avoid timeouts (Gupshup expects 200 OK)
  res.status(200).end();

  try {
    // Log minimal info for diagnostics
    console.log(
      "[WEBHOOK HIT]",
      new Date().toISOString(),
      "method=",
      req.method,
      "ct=",
      req.headers["content-type"],
      "keys=",
      Object.keys(req.body || {})
    );

    const eventType =
      (req.body && req.body.type) ||
      (req.body && req.body.event) || // fallback, just in case
      null;

    if (eventType !== "message") {
      // Ignore non-message events quietly
      return;
    }

    const p = req.body.payload || {};
    const msgType = p.type;
    const from = (p.sender && p.sender.phone) || p.source;
    if (!from) return;

    let userText = "";
    if (msgType === "text") {
      userText = (p.payload && p.payload.text) || "";
    } else if (msgType === "button_reply" || msgType === "list_reply") {
      userText = p.payload?.title || p.payload?.postbackText || "";
    } else {
      await sendWhatsAppText({
        to: from,
        text:
          "Por ora, consigo ler apenas mensagens de texto. Pode tentar novamente?",
      });
      return;
    }

    // Masked inbound log
    safeLog("INBOUND", req.body);

    const answer = await askCristina({ userText, userPhone: String(from) });
    if (answer) {
      await sendWhatsAppText({ to: from, text: answer });
    }
  } catch (err) {
    console.error("ERR inbound:", err?.response?.data || err);
  }
}

// --- Map multiple paths to the same handler ---
app.post("/webhook/gupshup", handleInbound);
// Alias: allow POST on /healthz as fallback (some consoles validate/route here)
app.post("/healthz", handleInbound);
// Alias: allow POST on root as a last-resort fallback
app.post("/", handleInbound);

// --- Start server ---
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
