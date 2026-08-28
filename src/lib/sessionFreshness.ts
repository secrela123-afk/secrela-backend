export function isSessionFresh(
  authFreshAt: Date | null | undefined,
  ttlMs: number,
): boolean {
  if (!authFreshAt) return false;
  return Date.now() - authFreshAt.getTime() < ttlMs;
}

export function toSessionFreshness(
  authFreshAt: Date | null | undefined,
  ttlMs: number,
): { fresh: boolean; freshUntil: string | null } {
  const fresh = isSessionFresh(authFreshAt, ttlMs);
  if (!fresh || !authFreshAt) {
    return { fresh: false, freshUntil: null };
  }

  return {
    fresh: true,
    freshUntil: new Date(authFreshAt.getTime() + ttlMs).toISOString(),
  };
}

export type DualSessionFreshness = {
  /** MEDIUM: recent password proof */
  medium: { fresh: boolean; freshUntil: string | null };
  /** HIGH: recent password (+ MFA factor when enabled) */
  high: { fresh: boolean; freshUntil: string | null };
  /** Alias of medium — kept for older clients */
  fresh: boolean;
  freshUntil: string | null;
};

export function toDualSessionFreshness(
  authFreshAt: Date | null | undefined,
  authHighFreshAt: Date | null | undefined,
  ttlMs: number,
): DualSessionFreshness {
  const medium = toSessionFreshness(authFreshAt, ttlMs);
  const high = toSessionFreshness(authHighFreshAt, ttlMs);
  return {
    medium,
    high,
    fresh: medium.fresh,
    freshUntil: medium.freshUntil,
  };
}
