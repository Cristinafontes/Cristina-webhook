import express from "express";
import bodyParser from "body-parser";
import { cancelEventFromMessage } from "./gcal.esm.js";

const app = express();
app.use(bodyParser.json());

// Rota de teste de saúde
app.get("/", (req, res) => {
  res.send("Servidor de cancelamento ativo ✅");
});

// Rota para cancelar eventos a partir da mensagem
app.post("/cancel-from-message", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ ok: false, error: "Texto não fornecido" });
    }

    const result = await cancelEventFromMessage(text);
    res.json(result);
  } catch (error) {
    console.error("Erro ao cancelar:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Cancel server rodando na porta " + PORT);
});
