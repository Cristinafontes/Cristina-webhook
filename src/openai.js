import axios from "axios";

export async function askCristina(message) {
  const prompt = `Você é uma secretária médica. Extraia intenção (agendar/cancelar) e data/hora.
Responda no formato:
- Agendar: "Pronto! Sua consulta com a Dra. Jenifer está agendada para o dia dd/mm/aa, horário hh:mm."
- Cancelar: "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia dd/mm/aa, horário hh:mm."`;

  const res = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: process.env.OPENAI_MODEL,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: message }
    ]
  }, {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  return res.data.choices[0].message.content.trim();
}
