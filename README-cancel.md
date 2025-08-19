# Servidor independente de CANCELAMENTO (add-on)

> **Objetivo**: um servidor separado, com a **única função** de cancelar a consulta no Google Calendar quando a sua atendente virtual enviar a mensagem ao paciente contendo "…está **cancelada** para o dia dd/mm/aa, horário HH:MM".  
> **Sem alterar** nenhuma senha/ID/token já configurados no Railway.  
> Ele usa exatamente as mesmas variáveis de ambiente do seu projeto atual.

## O que este pacote adiciona
- `src/server.cancel.js` – novo servidor Express, porta padrão **8081**, com o endpoint `POST /cancel-from-message`.
- `src/google.cancel.esm.js` – autenticação Google e rotina de cancelamento.
- `examples/curl-cancel.ps1` – comando de teste para Windows PowerShell.
- **Não** mexe em nenhum arquivo existente. Você só precisa subir estes novos arquivos para o **mesmo repositório**.

## Como funciona
1. Seu bot/fluxo envia para este servidor o **texto da mensagem** que foi enviada ao paciente.  
2. O servidor verifica se a frase contém a palavra **"cancelada"**. Se não tiver, não faz nada.
3. Ele **extrai a data e hora** do texto (ex: `19/08/25, 10:00`), converte para UTC e procura um evento no Google Calendar dentro de uma janela de ±30min do horário capturado.
4. Se encontrar, **cancela** o primeiro evento (envia update aos convidados).

## Endpoints
- `GET /` – healthcheck.
- `POST /cancel-from-message` – corpo JSON:  
  ```json
  { "text": "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia 19/08/25, horário 10:00." }
  ```
  Respostas possíveis:
  - 200 `{ ok: true, cancelled: true, cancelledEventId, cancelledEventSummary, timeWindow }`
  - 404 `{ ok: false, cancelled: false, error: "Nenhum evento compatível encontrado...", timeWindow }`
  - 400 / 500 com mensagem de erro quando aplicável

## Variáveis de ambiente
Reaproveita as MESMAS variáveis que você já tem no Railway (não mude nada):
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_ID` (pode ser `primary`)
- `TZ` (ex.: `America/Sao_Paulo`)

## Deploy no Railway (sem tocar no serviço atual)
1. **GitHub**: faça commit destes novos arquivos no mesmo repositório (não altere nada do que já existe).
2. **Railway**: clique em **+ New** → **Service** → **Deploy from GitHub repo**.
3. Em **Root Directory** (ou "Monorepo path"), deixe vazio (raiz do repo) e em **Start Command** coloque:  
   ```
   node src/server.cancel.js
   ```
   > Isso cria um **segundo serviço** dentro do mesmo projeto, rodando só o cancelamento.
4. Em **Variables** do novo serviço, **não crie nada novo**: copie **os mesmos valores** já usados pelo serviço principal (ou use “linked variables” quando disponível).  
   > Os nomes são os mesmos já usados: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `TZ`.
5. **Deploy**: aguarde ficar verde. O Railway mostrará a URL pública do **cancel-server** (por ex.: `https://cristina-cancel.up.railway.app`).

## Como integrar no seu fluxo (sem código)
- No Gupshup (ou no seu orquestrador), **acrescente uma chamada HTTP** (webhook) **depois** de enviar a mensagem de confirmação ao paciente.
- Configure uma requisição `POST` para a URL do cancel-server:  
  **URL**: `https://SEU-SUBDOMINIO.railway.app/cancel-from-message`  
  **Body (JSON)**:  
  ```json
  { "text": "{{a-mensagem-que-foi-enviada-ao-paciente}}" }
  ```
- Sempre que a frase tiver “**cancelada** … dia dd/mm/aa, horário HH:MM”, o evento desse horário será cancelado.

## Teste rápido no Windows (PowerShell)
Abra o **PowerShell** e rode o arquivo `examples/curl-cancel.ps1` (edite a URL):
```powershell
# examples/curl-cancel.ps1
$body = @{
  text = "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia 19/08/25, horário 10:00."
} | ConvertTo-Json

curl -Method POST `
  -Uri "https://SEU-SUBDOMINIO.railway.app/cancel-from-message" `
  -Body $body `
  -ContentType "application/json"
```

## Observações importantes
- A detecção da data/hora usa o mesmo parser já existente do seu projeto.
- A janela de busca é de **±30 minutos** ao redor do horário extraído.
- Se houver mais de um evento na janela, **o primeiro** é cancelado. Se quiser regras adicionais (ex.: filtrar por título), me avise que ajusto.
- Este add-on **não agenda** nada – ele só **cancela**.

Boa implantação!
