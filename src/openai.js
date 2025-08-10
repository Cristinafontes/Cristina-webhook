import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function askCristina({ userText, userPhone }) {
  const instructions = await resolveInstructions();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const response = await client.responses.create({
    model,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: [{ type: "text", text: `Usuário: ${mask(userPhone)} diz: ${userText}` }] }
    ]
  });

  const text = response.output_text?.trim?.() ?? "";
  return text;
}

function mask(phone) {
  if (!phone) return "";
  return phone.replace(/(\d{2})(\d{2})(\d{1,5})(\d{4})/, "+$1 ($2) $3-****");
}

async function resolveInstructions() {
  const raw = process.env.CRISTINA_INSTRUCTIONS || "";
  if (raw.startsWith("@")) {
    const fs = await import("fs/promises");
    const path = raw.slice(1);
    return await fs.readFile(path, "utf8");
  }
  return raw;
}
