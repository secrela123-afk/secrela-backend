/**
 * Lightweight User-Agent summary for security emails.
 * Not a full browser database — good enough for “Chrome on Windows”-style notices.
 */
export function summarizeUserAgent(userAgent: string | undefined | null): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  let browser = "Unknown browser";
  if (/Edg\//i.test(ua)) browser = "Microsoft Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";

  let os = "Unknown OS";
  if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return `${browser} on ${os}`;
}

export function formatEmailTimestamp(date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

export function summarizeClientIp(ip: string | undefined | null): string {
  const value = (ip ?? "").trim();
  if (!value) return "Unknown IP";
  return value;
}
