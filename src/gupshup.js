import axios from "axios";
const GS_ENDPOINT = "https://api.gupshup.io/wa/api/v1/msg";

export async function sendWhatsAppText({ to, text }) {
  if (!process.env.GUPSHUP_API_KEY) throw new Error("GUPSHUP_API_KEY ausente");
  if (!process.env.GUPSHUP_SOURCE_NUMBER) throw new Error("GUPSHUP_SOURCE_NUMBER ausente");

  const payload = new URLSearchParams();
  payload.append("channel", "whatsapp");
  payload.append("source", process.env.GUPSHUP_SOURCE_NUMBER);
  payload.append("destination", to);
  payload.append("message", JSON.stringify({ type: "text", text }));
  if (process.env.GUPSHUP_APP_NAME) payload.append("src.name", process.env.GUPSHUP_APP_NAME);

  const { data } = await axios.post(GS_ENDPOINT, payload, {
    headers: { apikey: process.env.GUPSHUP_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000
  });
  return data;
}
