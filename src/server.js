import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";

import { askCristina } from "./openai.js";
import { sendWhatsAppText } from "./gupshup.js";
import { safeLog } from "./redact.js";
import { parseCandidateDateTime, formatBRDate, normalizePhoneForTitle, extractPatientName, detectIntent, parseModality, isAffirmative, isNegative } from "./utils.esm.js";
import { createCalendarEvent, findAndCancelEvent } from "./google.esm.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet({ hidePoweredBy: true }));
app.use(compression());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "production") app.use(morgan("tiny"));

// Memória simples por sessão (telefone)
const pending = new Map(); // phone -> { type: 'create'|'cancel', dd,mm,yyyy,HH,MM,startISO,endISO, modality, name }

function extractText(payload) {
  return payload?.message?.text || payload?.payload?.payload?.text || payload?.text || "";
}
function fromField(payload, key) {
  return payload?.sender?.[key] || payload?.payload?.sender?.[key] || payload?.[key];
}

async function handleInbound(req, res) {
  try {
    const payload = req.body?.payload ? JSON.parse(req.body.payload) : (req.body || {});
    const text = extractText(payload);
    const phone = String(fromField(payload, "phone") || "").trim();
    const nameWs = String(fromField(payload, "name") || "").trim() || "Paciente";
    const to = phone;

    safeLog("Inbound", { payload: { sender: { phone, name: nameWs } }, text });

    // Se existe pendência aguardando confirmação
    if (pending.has(phone)) {
      const p = pending.get(phone);
      if (isNegative(text)) {
        pending.delete(phone);
        await sendWhatsAppText({ to, text: "Sem problemas, não vou prosseguir. Se quiser, me informe um novo dia e horário. 😊" });
        return res.status(200).end("ok");
      }
      if (isAffirmative(text)) {
        const { dmy, hm } = formatBRDate(p);
        if (p.type === "create") {
          // Mensagem final solicitada pelo cliente (antes de alterar o calendário)
          await sendWhatsAppText({ to, text: `Pronto! Sua consulta com a Dra. Jenifer está agendada para o dia ${dmy}, horário ${hm}.` });
          const phonePretty = normalizePhoneForTitle(phone);
          const summary = `Consulta Dra. Jenifer [${dmy} ${hm}] - Paciente ${p.name || nameWs} e telefone ${phonePretty}${p.modality ? ` [${p.modality}]` : ""}`;

          const created = await createCalendarEvent({
            startISO: p.startISO, endISO: p.endISO,
            patientName: p.name || nameWs,
            patientPhone: phone,
            summary,
            description: `Agendado automaticamente via WhatsApp (${p.modality || "modalidade não informada"}).`,
            location: process.env.CLINIC_ADDRESS || "Clínica",
          });

          if (created.conflict) {
            await sendWhatsAppText({ to, text: "Ops! Esse horário acabou de ficar indisponível. Podemos tentar outro próximo?" });
          }
        } else if (p.type === "cancel") {
          await sendWhatsAppText({ to, text: `Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia ${dmy}, horário ${hm}.` });
          const result = await findAndCancelEvent({ targetStartISO: p.startISO, phoneHint: phone });
          if (!result.found) {
            await sendWhatsAppText({ to, text: "Não localizei um evento exatamente nesse horário para seu número. Pode me confirmar a data/hora novamente?" });
          }
        }
        pending.delete(phone);
        return res.status(200).end("ok");
      }
      // Ainda aguardando confirmação
      await sendWhatsAppText({ to, text: 'Só preciso de um "sim" para prosseguir, ou "não" para cancelar o pedido. 😊' });
      return res.status(200).end("ok");
    }

    // Nova interação (sem pendências)
    const { isCancel, isCreate } = detectIntent(text);
    const parsed = parseCandidateDateTime(text);
    const modality = parseModality(text);
    const nameCandidate = extractPatientName(text) || nameWs;

    if ((isCreate || isCancel) && parsed.found) {
      const { dd, mm, yyyy, HH, MM, startISO, endISO } = parsed;
      const { dmy, hm } = formatBRDate({ dd, mm, yyyy, HH, MM });
      const modLabel = modality || "presencial";
      const tipo = isCancel ? "cancelar" : "agendar";
      const valor = isCancel ? "" : " O valor da consulta é R$ 450,00.";
      // Guarda pendência
      pending.set(phone, { type: isCancel ? "cancel" : "create", dd, mm, yyyy, HH, MM, startISO, endISO, modality: modLabel, name: nameCandidate });
      // Pergunta de confirmação conforme prompt
      await sendWhatsAppText({ to, text: `Posso ${tipo} sua consulta para o dia ${dmy}, às ${hm}, ${modLabel}?${valor} Por favor, confirme.` });
      return res.status(200).end("ok");
    }

    // Fallback para conversa geral
    const reply = await askCristina({ userText: text, userPhone: phone });
    await sendWhatsAppText({ to, text: reply });
    return res.status(200).end("ok");
  } catch (err) {
    console.error("handleInbound error:", err?.message || err);
    return res.status(200).end("ok");
  }
}

app.post("/webhook/gupshup", handleInbound);
app.post("/healthz", handleInbound);
app.post("/", handleInbound);

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
