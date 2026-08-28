import type { Request } from "express";
import { env } from "../config/env.js";

export type RequestClientMeta = {
  /** Normalized client IP suitable for session storage / audit */
  ip: string | null;
  /** Raw User-Agent (truncated for storage) */
  userAgent: string | null;
};

const MAX_UA_LENGTH = 512;

/**
 * Normalize socket / proxy IP values into a stable IPv4/IPv6 string.
 * - ::1 → 127.0.0.1
 * - :ffff:192.0.2.1 → 192.0.2.1
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();

  if (!ip) return null;

  // Strip IPv6 zone id: fe80::1%eth0
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  if (ip.startsWith("::ffff:")) {
    ip = ip.slice("::ffff:".length);
  }

  if (ip === "::1") {
    return "127.0.0.1";
  }

  return ip;
}

function firstForwardedIp(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return normalizeIp(first);
}

/**
 * Client IP + User-Agent for sessions and security emails.
 *
 * X-Forwarded-For is only trusted when `TRUST_PROXY` is enabled
 * (behind Nginx / a load balancer). Otherwise we use the direct socket IP
 * so clients cannot spoof the address.
 */
export function getRequestClientMeta(req: Request): RequestClientMeta {
  const socketIp = normalizeIp(
    req.socket?.remoteAddress ?? req.ip ?? null,
  );

  const forwardedIp = env.trustProxy
    ? firstForwardedIp(req.headers["x-forwarded-for"])
    : null;

  const ip = forwardedIp ?? socketIp;

  const uaRaw = req.get("user-agent")?.trim() || null;
  const userAgent = uaRaw
    ? uaRaw.length > MAX_UA_LENGTH
      ? uaRaw.slice(0, MAX_UA_LENGTH)
      : uaRaw
    : null;

  return { ip, userAgent };
}
