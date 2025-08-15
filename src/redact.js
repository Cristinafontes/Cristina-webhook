export function safeLog(label, obj = {}) {
  try {
    const clone = JSON.parse(JSON.stringify(obj));
    if (clone?.payload?.source) clone.payload.source = mask(clone.payload.source);
    if (clone?.payload?.sender?.phone) clone.payload.sender.phone = mask(clone.payload.sender.phone);
    if (clone?.to) clone.to = mask(clone.to);
    console.log(label, JSON.stringify(clone));
  } catch {
    console.log(label);
  }
}

function mask(phone) {
  if (typeof phone !== "string") return phone;
  return phone.replace(/(\+?\d{0,2})(\d{2})(\d{4,5})(\d{4})/, "$1 ($2) $3-****");
}
