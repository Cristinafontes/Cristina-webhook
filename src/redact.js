export function safeLog(label, obj = {}) {
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone?.payload?.source) clone.payload.source = mask(clone.payload.source);
  if (clone?.payload?.sender?.phone) clone.payload.sender.phone = mask(clone.payload.sender.phone);
  console.log(label, JSON.stringify(clone));
}

function mask(phone) {
  if (typeof phone !== "string") return phone;
  return phone.replace(/(\d{2})(\d{2})(\d{1,5})(\d{4})/, "+$1 ($2) $3-****");
}
