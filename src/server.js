import express from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";

import { askCristina } from "./openai.js";
import { sendWhatsAppText } from "./gupshup.js";
import { createEvent, cancelEvent } from "./googleCalendar.js";
import { parseCandidateDateTime } from "./utils.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(helmet());
app.use(compression());
app.use(cors());

app.post("/webhook/gupshup", async (req, res) => {
  try {
    const message = req.body.payload?.payload?.text;
    const phone = req.body.payload?.sender?.phone || "";
    const aiResponse = await askCristina(message);
    await sendWhatsAppText(phone, aiResponse);

    const { found, startISO, endISO } = parseCandidateDateTime(aiResponse);
    if (found) {
      if (aiResponse.includes("está agendada")) {
        await createEvent({ startISO, endISO, nome: "Paciente", telefone: phone, modalidade: "Telemedicina" });
      } else if (aiResponse.includes("está cancelada")) {
        await cancelEvent({ startISO, endISO, titleContains: "Consulta Dra. Jenifer" });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(process.env.PORT || 8080, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT || 8080}`);
});
