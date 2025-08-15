import axios from "axios";
import qs from "qs";

export async function sendWhatsAppText(phone, message) {
  const url = "https://api.gupshup.io/wa/api/v1/msg";

  const data = qs.stringify({
    channel: "whatsapp",
    source: process.env.GUPSHUP_SOURCE_NUMBER,
    destination: phone,
    message: JSON.stringify({ type: "text", text: message }),
    srcName: process.env.GUPSHUP_APP_NAME
  });

  await axios.post(url, data, {
    headers: {
      "apikey": process.env.GUPSHUP_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
}
