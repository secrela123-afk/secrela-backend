/** Signup / billing plan slugs (payment gateway wired later). */
export const PLAN_SLUGS = [
  "free",
  "starter",
  "team",
  "business",
  "enterprise",
] as const;
export type PlanSlug = (typeof PLAN_SLUGS)[number];

/** Self-serve paid plans (checkout). Enterprise is sales-only / legacy. */
export const PAID_PLAN_SLUGS = ["starter", "team", "business"] as const;
export type PaidPlanSlug = (typeof PAID_PLAN_SLUGS)[number];

export function isPaidPlanSlug(slug: string | null | undefined): slug is PaidPlanSlug {
  return !!slug && (PAID_PLAN_SLUGS as readonly string[]).includes(slug);
}

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
 * Yearly = discounted monthly equivalent × 12 (landing “Save 20%”).
 * Business yearly uses $79×12 = $948 (~20% off $99).
 */
export const PLAN_PRICES_USD_CENTS: Record<
  PaidPlanSlug,
  { monthly: number; yearlyTotal: number }
> = {
  starter: { monthly: 2000, yearlyTotal: 1600 * 12 },
  team: { monthly: 6000, yearlyTotal: 4800 * 12 },
  business: { monthly: 9900, yearlyTotal: 7900 * 12 },
};

export function planDisplayName(slug: PlanSlug): string {
  if (slug === "free") return "Free trial";
  if (slug === "starter") return "Starter";
  if (slug === "team") return "Team";
  if (slug === "business") return "Business";
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
  if (!isPaidPlanSlug(planSlug)) return null;
  const prices = PLAN_PRICES_USD_CENTS[planSlug];
  return interval === "yearly" ? prices.yearlyTotal : prices.monthly;
}
