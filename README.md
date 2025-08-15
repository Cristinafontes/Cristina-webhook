# Cristina WhatsApp Webhook (Gupshup + OpenAI Responses API)

Este repositório conecta o WhatsApp Business (via **Gupshup**) à sua agente **Secretária Cristina** (OpenAI).

## Como funciona
- Recebe mensagens no endpoint `/webhook/gupshup` (callback do Gupshup).
- Envia o texto + **instruções da Cristina** para o **OpenAI Responses API**.
- Responde ao usuário pelo endpoint oficial do Gupshup.
- Sem armazenamento de dados por padrão (LGPD-friendly).

## Passo a passo
1. **Clone/deploy** este repo (GitHub → Railway/Render).
2. Configure as **variáveis de ambiente** (Railway/Render):
   - `OPENAI_API_KEY` (obrigatória)
   - `OPENAI_MODEL` (ex.: `gpt-4o-mini`)
   - `GUPSHUP_API_KEY`, `GUPSHUP_APP_NAME`, `GUPSHUP_SOURCE_NUMBER` (E.164)
   - `ALLOWED_ORIGINS` (opcional)
3. **Prompt da Cristina** já incluso em `./prompt.txt`. O `.env.example` aponta para ele com `CRISTINA_INSTRUCTIONS=@./prompt.txt`.

## Rodar localmente
```bash
npm install
cp .env.example .env
# Edite .env com suas chaves (não commitar)
npm run dev
```

## Configurar no Gupshup
- No painel do Gupshup, defina a **Callback URL** → `https://SEU_DOMINIO/webhook/gupshup`.
- Preencha `GUPSHUP_API_KEY` e demais dados no seu provedor de hospedagem.

## Segurança (LGPD)
- Logs com máscara de telefone.
- Sem banco de dados por padrão.
- Adicione persistência apenas com base legal e aviso ao paciente.

## Estrutura
```
/src/server.js    # Webhook + servidor
/src/openai.js    # Chamada ao OpenAI Responses API
/src/gupshup.js   # Envio de mensagens via Gupshup
/src/redact.js    # Sanitização de logs
prompt.txt        # Prompt oficial da Secretária Cristina (mantido no repositório)
.env.example      # Modelo de variáveis (sem segredos)
```
