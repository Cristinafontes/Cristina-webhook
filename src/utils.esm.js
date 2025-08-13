export function parseDateTimeFromStrings(dateStr, timeStr) {
  const [day, month, year] = dateStr.split("/").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  return new Date(2000 + year, month - 1, day, hour, minute);
}
