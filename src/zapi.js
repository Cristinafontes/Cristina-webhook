// src/zapi.js
import axios from "axios";

/**
 * Envia texto pelo Z-API (WhatsApp Web)
 * Requer:
 *  - ZAPI_INSTANCE
 *  - ZAPI_TOKEN
 *  - (opcional) ZAPI_ACCOUNT_TOKEN -> header Client-Token se habilitado na conta
 */
export async function sendZapiText({ phone, message }) {
  if (!process.env.ZAPI_INSTANCE) throw new Error("ZAPI_INSTANCE ausente");
  if (!process.env.ZAPI_TOKEN) throw new Error("ZAPI_TOKEN ausente");

  const base = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}`;

  const { data } = await axios.post(
    `${base}/send-text`,
    { phone, message },
    {
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ZAPI_ACCOUNT_TOKEN
          ? { "Client-Token": process.env.ZAPI_ACCOUNT_TOKEN }
          : {}),
      },
      timeout: 15000,
    }
  );

  return data; // retorna zaapId/messageId etc.
}
