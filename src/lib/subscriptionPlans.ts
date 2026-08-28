/** Signup / billing plan slugs (payment gateway wired later). */
export const PLAN_SLUGS = ["free", "starter", "team", "enterprise"] as const;
export type PlanSlug = (typeof PLAN_SLUGS)[number];

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "pending_payment",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const FREE_TRIAL_DAYS = 14;

/** Max bonus days an owner can grant beyond the initial trial (lifetime cap). */
export const MAX_TRIAL_BONUS_DAYS = 14;

/** Max days per single extension request. */
export const MAX_SINGLE_TRIAL_EXTENSION = 7;

/** Reminder offsets before period/trial end (days). */
export const EXPIRY_REMINDER_DAYS = [5, 3, 1] as const;

/**
 * List prices in USD cents.
 * Yearly = discounted monthly × 12 (matches landing “Save 20%” math).
 */
export const PLAN_PRICES_USD_CENTS: Record<
  Exclude<PlanSlug, "free" | "enterprise">,
  { monthly: number; yearlyTotal: number }
> = {
  starter: { monthly: 2800, yearlyTotal: 2200 * 12 },
  team: { monthly: 3600, yearlyTotal: 2900 * 12 },
};

export function planDisplayName(slug: PlanSlug): string {
  if (slug === "free") return "Free trial";
  if (slug === "starter") return "Starter";
  if (slug === "team") return "Team";
  return "Enterprise";
}

export function periodMsForInterval(interval: BillingInterval): number {
  const day = 24 * 60 * 60 * 1000;
  return interval === "yearly" ? 365 * day : 30 * day;
}

export function amountCentsForPlan(
  planSlug: PlanSlug,
  interval: BillingInterval,
): number | null {
  if (planSlug === "free" || planSlug === "enterprise") return null;
  const prices = PLAN_PRICES_USD_CENTS[planSlug];
  return interval === "yearly" ? prices.yearlyTotal : prices.monthly;
}
