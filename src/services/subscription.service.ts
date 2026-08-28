import { AppError } from "../lib/errors/AppError.js";
import {
  amountCentsForPlan,
  EXPIRY_REMINDER_DAYS,
  FREE_TRIAL_DAYS,
  MAX_SINGLE_TRIAL_EXTENSION,
  MAX_TRIAL_BONUS_DAYS,
  periodMsForInterval,
  planDisplayName,
  type BillingInterval,
  type PlanSlug,
  type SubscriptionStatus,
} from "../lib/subscriptionPlans.js";
import { Organization } from "../models/Organization.model.js";
import type { OrganizationDocument } from "../models/Organization.model.js";
import { Membership } from "../models/Membership.model.js";
import { Session } from "../models/Session.model.js";
import { notifyOwnersAndAdmins } from "./notification.service.js";

export type SubscriptionSnapshot = {
  planSlug: PlanSlug;
  subscriptionStatus: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  subscriptionAmountCents: number | null;
  currency: string;
  autoRenew: boolean;
  autoRenewInterval: BillingInterval | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  trialBonusDaysGranted: number;
  trialBonusDaysRemaining: number;
  planLabel: string;
  daysUntilExpiry: number | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function trialBonusDaysRemaining(org: OrganizationDocument): number {
  const granted = org.trialBonusDaysGranted ?? 0;
  return Math.max(0, MAX_TRIAL_BONUS_DAYS - granted);
}

function relevantExpiryDate(org: OrganizationDocument): Date | null {
  if (org.subscriptionStatus === "trialing") return org.trialEndsAt ?? null;
  if (org.subscriptionStatus === "active") return org.currentPeriodEndsAt ?? null;
  return null;
}

export function daysUntilExpiry(org: OrganizationDocument): number | null {
  const end = relevantExpiryDate(org);
  if (!end) return null;
  const diff = end.getTime() - Date.now();
  if (diff < 0) return 0;
  return Math.ceil(diff / MS_PER_DAY);
}

export function subscriptionSnapshot(
  org: OrganizationDocument,
): SubscriptionSnapshot {
  return {
    planSlug: (org.planSlug ?? "starter") as PlanSlug,
    subscriptionStatus: (org.subscriptionStatus ??
      "pending_payment") as SubscriptionStatus,
    billingInterval: (org.billingInterval ?? null) as BillingInterval | null,
    subscriptionAmountCents: org.subscriptionAmountCents ?? null,
    currency: org.currency ?? "USD",
    autoRenew: Boolean(org.autoRenew),
    autoRenewInterval: (org.autoRenewInterval ??
      null) as BillingInterval | null,
    trialEndsAt: org.trialEndsAt ?? null,
    currentPeriodEndsAt: org.currentPeriodEndsAt ?? null,
    trialBonusDaysGranted: org.trialBonusDaysGranted ?? 0,
    trialBonusDaysRemaining: trialBonusDaysRemaining(org),
    planLabel: org.plan ?? planDisplayName((org.planSlug ?? "starter") as PlanSlug),
    daysUntilExpiry: daysUntilExpiry(org),
  };
}

export function applyPlanAtSignup(
  org: OrganizationDocument,
  planSlug: PlanSlug,
): void {
  org.planSlug = planSlug;
  org.plan = planDisplayName(planSlug);
  org.billingInterval = null;
  org.subscriptionAmountCents = null;
  org.autoRenew = false;
  org.autoRenewInterval = null;
  org.lastExpiryReminderDays = null;
  org.lastExpiryReminderAt = null;

  if (planSlug === "free") {
    org.subscriptionStatus = "trialing";
    org.trialEndsAt = new Date(Date.now() + FREE_TRIAL_DAYS * MS_PER_DAY);
    org.currentPeriodEndsAt = null;
    return;
  }

  // Paid / enterprise — waiting for activation (payment gateway later).
  org.subscriptionStatus = "pending_payment";
  org.trialEndsAt = null;
  org.currentPeriodEndsAt = null;
}

async function revokeSessionsForOrganization(
  organizationId: string,
): Promise<void> {
  const members = await Membership.find({ organizationId }).select("userId").lean();
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) return;

  await Session.updateMany(
    { userId: { $in: userIds }, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

async function markExpired(
  org: OrganizationDocument,
  revokeSessions: boolean,
): Promise<void> {
  const wasTrialing = org.subscriptionStatus === "trialing";
  await Organization.findByIdAndUpdate(org._id, {
    $set: {
      subscriptionStatus: "expired",
      ...(wasTrialing ? { trialEndsAt: null } : {}),
    },
  });
  org.subscriptionStatus = "expired";
  if (wasTrialing) {
    org.trialEndsAt = null;
  }

  if (revokeSessions) {
    await revokeSessionsForOrganization(org._id.toString());
  }
}

/**
 * Auto-renew without payment gateway: extend currentPeriodEndsAt and keep active.
 * When Stripe exists, this becomes “charge then extend”.
 */
async function autoRenewIfEnabled(org: OrganizationDocument): Promise<boolean> {
  if (!org.autoRenew) return false;
  const interval = (org.autoRenewInterval ??
    org.billingInterval) as BillingInterval | null;
  if (!interval) return false;

  const planSlug = (org.planSlug ?? "starter") as PlanSlug;
  if (planSlug === "free" || planSlug === "enterprise") return false;

  const amount = amountCentsForPlan(planSlug, interval);
  const base = Math.max(org.currentPeriodEndsAt?.getTime() ?? 0, Date.now());
  const newEnd = new Date(base + periodMsForInterval(interval));

  const updated = await Organization.findByIdAndUpdate(
    org._id,
    {
      $set: {
        subscriptionStatus: "active",
        billingInterval: interval,
        autoRenewInterval: interval,
        subscriptionAmountCents: amount,
        currentPeriodEndsAt: newEnd,
        lastExpiryReminderDays: null,
        lastExpiryReminderAt: null,
      },
    },
    { new: true },
  );

  if (!updated) return false;

  org.subscriptionStatus = "active";
  org.billingInterval = interval;
  org.autoRenewInterval = interval;
  org.subscriptionAmountCents = amount;
  org.currentPeriodEndsAt = newEnd;
  org.lastExpiryReminderDays = null;
  org.lastExpiryReminderAt = null;

  await notifyOwnersAndAdmins({
    organizationId: org._id.toString(),
    type: "subscription.renewed",
    title: "Subscription renewed",
    body: `Your ${planDisplayName(planSlug)} plan was renewed for another ${interval === "yearly" ? "year" : "month"}.`,
    href: "/app/settings",
    meta: { planSlug, interval, amountCents: amount },
  });

  return true;
}

async function expirePaidOrTrialIfNeeded(
  org: OrganizationDocument,
): Promise<void> {
  if (org.subscriptionStatus === "trialing" && org.trialEndsAt) {
    if (org.trialEndsAt.getTime() > Date.now()) return;
    await markExpired(org, false);
    return;
  }

  if (org.subscriptionStatus === "active" && org.currentPeriodEndsAt) {
    if (org.currentPeriodEndsAt.getTime() > Date.now()) return;
    const renewed = await autoRenewIfEnabled(org);
    if (!renewed) {
      await markExpired(org, false);
    }
  }
}

/**
 * Fire at most one reminder per day-bucket (5 / 3 / 1) before expiry.
 */
export async function maybeSendExpiryReminders(
  org: OrganizationDocument,
): Promise<void> {
  const days = daysUntilExpiry(org);
  if (days === null) return;
  if (!EXPIRY_REMINDER_DAYS.includes(days as (typeof EXPIRY_REMINDER_DAYS)[number])) {
    return;
  }
  if (org.lastExpiryReminderDays === days) return;

  const planLabel =
    org.plan ?? planDisplayName((org.planSlug ?? "starter") as PlanSlug);
  const dayWord = days === 1 ? "day" : "days";

  await notifyOwnersAndAdmins({
    organizationId: org._id.toString(),
    type: "subscription.expiring",
    title: `Subscription ends in ${days} ${dayWord}`,
    body: `Your ${planLabel} access ends in ${days} ${dayWord}. Renew now to keep your workspace.`,
    href: "/checkout",
    meta: { daysLeft: days, planSlug: org.planSlug },
  });

  await Organization.findByIdAndUpdate(org._id, {
    $set: {
      lastExpiryReminderDays: days,
      lastExpiryReminderAt: new Date(),
    },
  });
  org.lastExpiryReminderDays = days;
  org.lastExpiryReminderAt = new Date();
}

/**
 * Sync expiry / auto-renew / reminders, then block expired + pending_payment.
 */
export async function assertActiveSubscription(
  org: OrganizationDocument,
): Promise<void> {
  await expirePaidOrTrialIfNeeded(org);
  await maybeSendExpiryReminders(org);

  if (org.subscriptionStatus === "expired") {
    throw new AppError(
      403,
      "Your subscription has ended. Renew a plan to continue.",
      { code: "SUBSCRIPTION_EXPIRED" },
    );
  }

  if (org.subscriptionStatus === "pending_payment") {
    throw new AppError(
      403,
      "Complete your subscription to access the workspace.",
      { code: "SUBSCRIPTION_PAYMENT_REQUIRED" },
    );
  }
}

/**
 * Activate a paid plan for an interval (payment gateway later — records DB state now).
 */
export async function activateOrganizationSubscription(
  org: OrganizationDocument,
  planSlug: PlanSlug,
  interval: BillingInterval,
): Promise<OrganizationDocument> {
  if (planSlug === "free") {
    throw new AppError(400, "Use the free trial path for the free plan", {
      code: "INVALID_PLAN",
    });
  }
  if (planSlug === "enterprise") {
    throw new AppError(
      400,
      "Enterprise plans are activated by sales. Contact sales@secrela.com.",
      { code: "ENTERPRISE_CONTACT_REQUIRED" },
    );
  }

  const amount = amountCentsForPlan(planSlug, interval);
  const periodEnd = new Date(Date.now() + periodMsForInterval(interval));

  const updated = await Organization.findByIdAndUpdate(
    org._id,
    {
      $set: {
        planSlug,
        plan: planDisplayName(planSlug),
        subscriptionStatus: "active",
        billingInterval: interval,
        autoRenewInterval: org.autoRenew ? interval : org.autoRenewInterval,
        subscriptionAmountCents: amount,
        currency: "USD",
        trialEndsAt: null,
        currentPeriodEndsAt: periodEnd,
        lastExpiryReminderDays: null,
        lastExpiryReminderAt: null,
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  return updated;
}

export async function updateAutoRenewSettings(
  org: OrganizationDocument,
  input: { autoRenew: boolean; autoRenewInterval?: BillingInterval | null },
): Promise<OrganizationDocument> {
  // Renew using the interval they already paid for (no second picker).
  const interval =
    org.billingInterval ??
    org.autoRenewInterval ??
    input.autoRenewInterval ??
    null;

  if (input.autoRenew && !interval) {
    throw new AppError(
      400,
      "Activate a paid plan first — auto-renew follows your billing interval.",
      { code: "AUTO_RENEW_REQUIRES_PLAN" },
    );
  }

  const updated = await Organization.findByIdAndUpdate(
    org._id,
    {
      $set: {
        autoRenew: input.autoRenew,
        autoRenewInterval: input.autoRenew ? interval : null,
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  return updated;
}

/**
 * Owner-granted trial extension (limited bonus days).
 */
export async function extendOrganizationTrial(
  org: OrganizationDocument,
  days: number,
): Promise<OrganizationDocument> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_SINGLE_TRIAL_EXTENSION) {
    throw new AppError(
      400,
      `Enter between 1 and ${MAX_SINGLE_TRIAL_EXTENSION} days per extension`,
      { code: "INVALID_TRIAL_EXTENSION_DAYS" },
    );
  }

  const remaining = trialBonusDaysRemaining(org);
  if (days > remaining) {
    throw new AppError(
      400,
      `Only ${remaining} bonus day(s) can still be granted for this workspace`,
      { code: "TRIAL_EXTENSION_LIMIT", details: { remaining } },
    );
  }

  const now = Date.now();
  const currentEnd = org.trialEndsAt?.getTime() ?? 0;
  const base =
    org.subscriptionStatus === "trialing" && currentEnd > now
      ? currentEnd
      : now;
  const newEndsAt = new Date(base + days * MS_PER_DAY);
  const bonusGranted = (org.trialBonusDaysGranted ?? 0) + days;

  const updated = await Organization.findByIdAndUpdate(
    org._id,
    {
      $set: {
        subscriptionStatus: "trialing",
        planSlug: "free",
        plan: planDisplayName("free"),
        trialEndsAt: newEndsAt,
        trialBonusDaysGranted: bonusGranted,
        billingInterval: null,
        subscriptionAmountCents: null,
        currentPeriodEndsAt: null,
        lastExpiryReminderDays: null,
        lastExpiryReminderAt: null,
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  return updated;
}
