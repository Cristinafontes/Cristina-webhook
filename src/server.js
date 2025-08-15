// src/server.js
import express from "express";
import rateLimit from "express-rate-limit";
import morgan from "morgan";

// Opcional: importa o handler do webhook, se existir
let externalGupshupHandler = null;
try {
  const mod = await import("./gupshup.esm.js");
  externalGupshupHandler = mod?.handleGupshup || null;
} catch (_) {
  /* se não existir, usamos fallback */
}

const app = express();

// Necessário para evitar ERR_ERL_UNEXPECTED_X_FORWARDED_FOR na Railway
app.set("trust proxy", 1);

// Limite de requisições
const limiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minuto
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Logs básicos
app.use(morgan("tiny"));

// Healthcheck
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

// Webhook da Gupshup - precisa ser POST HTTPS
app.post("/webhook/gupshup", async (req, res, next) => {
  try {
    if (typeof externalGupshupHandler === "function") {
      await externalGupshupHandler(req, res);
      return;
    }
    console.log("[WEBHOOK HIT]", new Date().toISOString(), "payload keys:", Object.keys(req.body || {}));
    res.status(200).json({ status: "received" });
  } catch (err) {
    next(err);
  }
});

// 404 controlado
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Tratamento de erros
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err?.message || err);
  res.status(500).json({ error: "Internal server error" });
});

// Inicia servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
