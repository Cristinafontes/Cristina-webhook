// gupshup.js (com logs detalhados)
import axios from "axios";

const GS_ENDPOINT = "https://api.gupshup.io/sm/api/v1/msg";

export async function sendWhatsAppText(to, text) {
  const APP = process.env.GUPSHUP_APP_NAME;
  const KEY = process.env.GUPSHUP_API_KEY;
  if (!APP || !KEY) {
    console.error("[GS SEND ERROR] Missing GUPSHUP_APP_NAME or GUPSHUP_API_KEY.");
    throw new Error("Missing Gupshup credentials");
  }

  const payload = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GUPSHUP_SOURCE_NUMBER || "",
    destination: String(to),
    'message': JSON.stringify({ type: "text", text: String(text) }),
    'src.name': APP,
  });

  try {
    const r = await axios.post(GS_ENDPOINT, payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "apikey": KEY,
      },
      timeout: 15000,
    });
    console.log("[GS SEND] to=", to, "status=", r.status, "resp=", r.data);
    return r.data;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error("[GS SEND ERROR]", status, data || e.message || e);
    throw e;
  }
}
