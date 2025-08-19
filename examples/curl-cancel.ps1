# examples/curl-cancel.ps1
# Substitua a URL abaixo pela URL do serviço no Railway
$body = @{
  text = "Pronto! Sua consulta com a Dra. Jenifer está cancelada para o dia 19/08/25, horário 10:00."
} | ConvertTo-Json

curl -Method POST `
  -Uri "https://SEU-SUBDOMINIO.railway.app/cancel-from-message" `
  -Body $body `
  -ContentType "application/json"
