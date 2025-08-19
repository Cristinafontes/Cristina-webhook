import express from "express";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import cors from "cors";
import { cancelEventFromMessage } from "./gcal.esm.js";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// evita warnings do express-rate-limit por X-Forwarded-For
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

app.get("/", (_req, res) => {
  res.status(200).send("Servidor de cancelamento ativo ✅");
});

/**
 * Cancela se a mensagem contém "cancelad" (cancelada/cancelado) e possui data+hora.
 * Body: { "text": "..." }
 */
app.post("/cancel-from-message", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Campo 'text' é obrigatório." });

    // Só procede se a frase indicar cancelamento
    if (!/cancelad/i.test(text)) {
      return res.status(200).json({ ok: true, skipped: true, reason: "mensagem não indica cancelamento" });
    }

    const result = await cancelEventFromMessage(text);
    return res.status(result?.cancelled ? 200 : 404).json(result);
  } catch (err) {
    console.error("[/cancel-from-message] error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log("[cancel-server] listening on", PORT));
