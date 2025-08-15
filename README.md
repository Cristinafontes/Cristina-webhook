# Cristina WhatsApp Webhook (Gupshup + Google Calendar)

**Novidades**
- ✳️ Agendamento com checagem de conflito (free/busy)
- ❌ Cancelamento do evento correspondente, via mensagem como: `cancelar 30/08 10:00`
- 📝 Título padronizado: `Consulta Dra. Jenifer [dd/mm/aa HH:mm] - Paciente [nome] e telefone [(DDD)99999-9999]`
- 🔒 Logs sem chaves ou dados sensíveis

**Endpoints (apenas POST, conforme solicitado)**
- `/webhook/gupshup`
- `/healthz`
- `/`

Veja `.env.example` e preencha as variáveis antes do deploy.
