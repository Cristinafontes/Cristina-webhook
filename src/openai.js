import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Ask Cristina (Chat Completions - simpler & stable)
 * @param {{ userText: string, userPhone?: string }} params
 * @returns {Promise<string>} assistant reply
 */
export async function askCristina({ userText, userPhone }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const system = process.env.CRISTINA_INSTRUCTIONS || "Você é a Secretária Cristina. Responda de forma breve, cordial e objetiva.";

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${userText}` },
      ],
    });

    const text =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Desculpe, não consegui processar sua mensagem agora.";
    return text;
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err);
    return "Desculpe, tive um problema técnico agora. Pode tentar novamente em instantes?";
  }
}
