export function parseCandidateDateTime(text, _tz = "America/Sao_Paulo") {
  if (!text) return { found: false };

  const re = /(\d{1,2}\/\d{1,2}\/\d{2,4}).*?(\d{1,2}:\d{2})/;
  const match = text.match(re);
  if (!match) return { found: false };

  const [_, dateStr, timeStr] = match;
  const [day, month, year] = dateStr.split("/").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const fullYear = year < 100 ? 2000 + year : year;

  const start = new Date(Date.UTC(fullYear, month - 1, day, hour + 3, minute));
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return { found: true, startISO: start.toISOString(), endISO: end.toISOString() };
}
