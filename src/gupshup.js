import axios from "axios";

export async function sendWhatsAppText(phone, message) {
  const url = `https://api.gupshup.io/wa/api/v1/msg`;
  await axios.post(url, null, {
    params: {
      channel: "whatsapp",
      source: process.env.GUPSHUP_SOURCE_NUMBER,
      destination: phone,
      message: { type: "text", text: message },
      srcName: process.env.GUPSHUP_APP_NAME
    },
    headers: {
      "apikey": process.env.GUPSHUP_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
}
