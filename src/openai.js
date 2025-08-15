import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function askCristina({ userText, userPhone }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const system = process.env.CRISTINA_INSTRUCTIONS ||
    "Você é a Secretária Cristina. Responda de forma breve, cordial e objetiva.";

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${userText}` },
      ],
      temperature: 0.4,
    });
    const text = completion?.choices?.[0]?.message?.content?.trim() ||
      "Desculpe, não consegui processar sua mensagem agora.";
    return text;
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err?.message || err);
    return "Desculpe, tive um problema técnico agora. Pode tentar novamente em instantes?";
  }
}
