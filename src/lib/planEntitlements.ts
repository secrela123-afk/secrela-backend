import type { PlanSlug } from "./subscriptionPlans.js";
import { planDisplayName } from "./subscriptionPlans.js";

/** null = unlimited */
export type PlanEntitlements = {
  maxMembers: number | null;
  maxVaults: number | null;
  maxSecrets: number | null;
  /** Can open audit log UI / API */
  auditLogAccess: boolean;
  /** Days of history when auditLogAccess; null = full history */
  auditRetentionDays: number | null;
  customRoles: boolean;
  securityCenter: boolean;
  integrations: boolean;
};

/**
 * Source of truth — must match landing pricing (`LandingPricing.tsx`).
 * Backend slugs: free | starter | team | business | enterprise (legacy)
 */
export const PLAN_ENTITLEMENTS: Record<PlanSlug, PlanEntitlements> = {
  free: {
    maxMembers: 1,
    maxVaults: 3,
    maxSecrets: 100,
    auditLogAccess: false,
    auditRetentionDays: null,
    customRoles: false,
    securityCenter: false,
    integrations: false,
  },
  starter: {
    maxMembers: 5,
    maxVaults: null,
    maxSecrets: null,
    auditLogAccess: true,
    auditRetentionDays: 7,
    customRoles: true,
    securityCenter: false,
    integrations: false,
  },
  team: {
    maxMembers: 10,
    maxVaults: null,
    maxSecrets: null,
    auditLogAccess: true,
    auditRetentionDays: null,
    customRoles: true,
    securityCenter: true,
    integrations: true,
  },
  business: {
    maxMembers: 25,
    maxVaults: null,
    maxSecrets: null,
    auditLogAccess: true,
    auditRetentionDays: null,
    customRoles: true,
    securityCenter: true,
    integrations: true,
  },
  enterprise: {
    maxMembers: null,
    maxVaults: null,
    maxSecrets: null,
    auditLogAccess: true,
    auditRetentionDays: null,
    customRoles: true,
    securityCenter: true,
    integrations: true,
  },
};

export type PlanLimitResource =
  | "members"
  | "vaults"
  | "secrets"
  | "customRoles";

export type PlanFeature =
  | "auditLogs"
  | "customRoles"
  | "securityCenter"
  | "integrations";

export function resolvePlanSlug(raw: string | null | undefined): PlanSlug {
  if (
    raw === "starter" ||
    raw === "team" ||
    raw === "business" ||
    raw === "enterprise"
  ) {
    return raw;
  }
  return "free";
}

export function getPlanEntitlements(planSlug: PlanSlug): PlanEntitlements {
  return PLAN_ENTITLEMENTS[planSlug];
}

/** Next paid tier for generic limit upgrades (members, vaults, secrets). */
export function recommendedUpgradePlan(planSlug: PlanSlug): PlanSlug | null {
  if (planSlug === "free") return "starter";
  if (planSlug === "starter") return "team";
  if (planSlug === "team") return "business";
  return null;
}

/** Smallest tier that unlocks a specific feature (may skip Starter). */
export function recommendedUpgradeForFeature(
  planSlug: PlanSlug,
  feature: PlanFeature,
): PlanSlug | null {
  if (feature === "securityCenter" || feature === "integrations") {
    if (planSlug === "free" || planSlug === "starter") return "team";
    return null;
  }
  return recommendedUpgradePlan(planSlug);
}

export function upgradePlanLabel(target: PlanSlug): string {
  return planDisplayName(target);
}

export function formatLimit(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}
