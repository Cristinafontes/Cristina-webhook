import express from "express";
import bodyParser from "body-parser";
import { cancelEventFromMessage } from "./gcal.esm.js";

const app = express();
app.use(bodyParser.json());

app.get("/", (_req, res) => {
  res.status(200).send("Servidor de cancelamento ativo ✅");
});

// Não exige a palavra "cancelada": qualquer texto com data/hora tenta cancelar
app.post("/cancel-from-message", async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.mensagem || "");
    if (!text) return res.status(400).json({ ok: false, error: "Faltou campo 'text' no JSON." });

    const result = await cancelEventFromMessage(text);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("[cancel-server] Listening on port", PORT);
});
