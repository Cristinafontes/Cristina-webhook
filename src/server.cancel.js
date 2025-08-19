// src/server.cancel.js
import express from "express";
import rateLimit from "express-rate-limit";
import { parseCancelDateTime } from "./utils.cancel.esm.js";
import { cancelEvent } from "./gcal.esm.js";

const app = express();
app.use(express.json());

// Para evitar erro de x-forwarded-for no Railway
app.set("trust proxy", 1);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});
app.use(limiter);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "cancel-api" });
});

app.post("/cancel-from-message", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "Mensagem vazia" });

    const parsed = parseCancelDateTime(text);
    if (!parsed.found) {
      return res.json({ ok: false, error: "Não consegui entender a data/horário na mensagem." });
    }

    const result = await cancelEvent(parsed.startISO, parsed.endISO);
    res.json({ ok: true, ...result, parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Cancel service running on port", PORT));
