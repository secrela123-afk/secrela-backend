import { AppError } from "../lib/errors/AppError.js";
import {
  getPlanEntitlements,
  recommendedUpgradeForFeature,
  recommendedUpgradePlan,
  resolvePlanSlug,
  upgradePlanLabel,
  type PlanEntitlements,
  type PlanFeature,
  type PlanLimitResource,
} from "../lib/planEntitlements.js";
import type { PlanSlug } from "../lib/subscriptionPlans.js";
import { planDisplayName } from "../lib/subscriptionPlans.js";
import { Invitation } from "../models/Invitation.model.js";
import { Membership } from "../models/Membership.model.js";
import { Organization } from "../models/Organization.model.js";
import { Role } from "../models/Role.model.js";
import { Secret } from "../models/Secret.model.js";
import { Vault } from "../models/Vault.model.js";

export type OrganizationUsage = {
  members: number;
  pendingInvites: number;
  seatsUsed: number;
  vaults: number;
  secrets: number;
  customRoles: number;
};

export type PlanEntitlementSnapshot = {
  planSlug: PlanSlug;
  planLabel: string;
  entitlements: PlanEntitlements;
  usage: OrganizationUsage;
  capabilities: {
    inviteMember: boolean;
    createVault: boolean;
    createSecret: boolean;
    createCustomRole: boolean;
    viewAuditLogs: boolean;
    viewSecurityCenter: boolean;
    viewIntegrations: boolean;
  };
  upgradePlanSlug: PlanSlug | "enterprise" | null;
  upgradePlanLabel: string | null;
};

function isWithinLimit(current: number, max: number | null): boolean {
  if (max === null) return true;
  return current < max;
}

function limitMessage(
  resource: PlanLimitResource,
  current: number,
  max: number,
  planSlug: PlanSlug,
): string {
  const upgrade = recommendedUpgradePlan(planSlug);
  const suffix = upgrade
    ? ` Upgrade to ${upgradePlanLabel(upgrade)} to increase this limit.`
    : "";
  const labels: Record<PlanLimitResource, string> = {
    members: "team members",
    vaults: "vaults",
    secrets: "secrets",
    customRoles: "custom roles",
  };
  return `Your ${planDisplayName(planSlug)} plan allows up to ${max} ${labels[resource]} (${current} in use).${suffix}`;
}

function featureMessage(
  feature: PlanFeature,
  planSlug: PlanSlug,
): string {
  const upgrade = recommendedUpgradeForFeature(planSlug, feature);
  const suffix = upgrade
    ? ` Upgrade to ${upgradePlanLabel(upgrade)} to unlock this feature.`
    : " Contact sales for Enterprise access.";
  const labels: Record<PlanFeature, string> = {
    auditLogs: "Audit logs",
    customRoles: "Custom roles",
    securityCenter: "Security Center",
    integrations: "Integrations",
  };
  return `${labels[feature]} is not included on your ${planDisplayName(planSlug)} plan.${suffix}`;
}

export async function getOrganizationUsage(
  organizationId: string,
): Promise<OrganizationUsage> {
  const [members, pendingInvites, vaults, secrets, customRoles] =
    await Promise.all([
      Membership.countDocuments({
        organizationId,
        status: { $ne: "disabled" },
      }),
      Invitation.countDocuments({ organizationId, status: "pending" }),
      Vault.countDocuments({ organizationId }),
      Secret.countDocuments({ organizationId }),
      Role.countDocuments({ organizationId, kind: "custom" }),
    ]);

  return {
    members,
    pendingInvites,
    seatsUsed: members + pendingInvites,
    vaults,
    secrets,
    customRoles,
  };
}

export async function loadOrganizationPlanContext(organizationId: string) {
  const organization = await Organization.findById(organizationId)
    .select("planSlug plan subscriptionStatus")
    .lean();
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  const planSlug = resolvePlanSlug(organization.planSlug);
  const entitlements = getPlanEntitlements(planSlug);
  const usage = await getOrganizationUsage(organizationId);
  return { organization, planSlug, entitlements, usage };
}

function buildCapabilities(
  planSlug: PlanSlug,
  entitlements: PlanEntitlements,
  usage: OrganizationUsage,
): PlanEntitlementSnapshot["capabilities"] {
  return {
    inviteMember: isWithinLimit(
      usage.seatsUsed,
      entitlements.maxMembers,
    ),
    createVault: isWithinLimit(usage.vaults, entitlements.maxVaults),
    createSecret: isWithinLimit(usage.secrets, entitlements.maxSecrets),
    createCustomRole:
      entitlements.customRoles &&
      isWithinLimit(usage.customRoles, null),
    viewAuditLogs: entitlements.auditLogAccess,
    viewSecurityCenter: entitlements.securityCenter,
    viewIntegrations: entitlements.integrations,
  };
}

export async function getPlanEntitlementSnapshot(
  organizationId: string,
): Promise<PlanEntitlementSnapshot> {
  const { planSlug, entitlements, usage } =
    await loadOrganizationPlanContext(organizationId);
  const upgrade = recommendedUpgradePlan(planSlug);

  return {
    planSlug,
    planLabel: planDisplayName(planSlug),
    entitlements,
    usage,
    capabilities: buildCapabilities(planSlug, entitlements, usage),
    upgradePlanSlug: upgrade,
    upgradePlanLabel: upgrade ? upgradePlanLabel(upgrade) : null,
  };
}

export async function assertPlanMemberCapacity(
  organizationId: string,
  additionalSeats = 1,
): Promise<void> {
  const { planSlug, entitlements, usage } =
    await loadOrganizationPlanContext(organizationId);
  const max = entitlements.maxMembers;
  if (max === null) return;

  const projected = usage.seatsUsed + additionalSeats;
  if (projected > max) {
    throw new AppError(403, limitMessage("members", usage.seatsUsed, max, planSlug), {
      code: "PLAN_LIMIT_REACHED",
      details: {
        resource: "members",
        limit: max,
        current: usage.seatsUsed,
        projected,
        planSlug,
        upgradePlanSlug: recommendedUpgradePlan(planSlug),
      },
    });
  }
}

export async function assertPlanCanCreateVault(
  organizationId: string,
): Promise<void> {
  const { planSlug, entitlements, usage } =
    await loadOrganizationPlanContext(organizationId);
  const max = entitlements.maxVaults;
  if (max === null) return;

  if (usage.vaults >= max) {
    throw new AppError(403, limitMessage("vaults", usage.vaults, max, planSlug), {
      code: "PLAN_LIMIT_REACHED",
      details: {
        resource: "vaults",
        limit: max,
        current: usage.vaults,
        planSlug,
        upgradePlanSlug: recommendedUpgradePlan(planSlug),
      },
    });
  }
}

export async function assertPlanCanCreateSecret(
  organizationId: string,
): Promise<void> {
  const { planSlug, entitlements, usage } =
    await loadOrganizationPlanContext(organizationId);
  const max = entitlements.maxSecrets;
  if (max === null) return;

  if (usage.secrets >= max) {
    throw new AppError(403, limitMessage("secrets", usage.secrets, max, planSlug), {
      code: "PLAN_LIMIT_REACHED",
      details: {
        resource: "secrets",
        limit: max,
        current: usage.secrets,
        planSlug,
        upgradePlanSlug: recommendedUpgradePlan(planSlug),
      },
    });
  }
}

export async function assertPlanFeature(
  organizationId: string,
  feature: PlanFeature,
): Promise<PlanEntitlements> {
  const { planSlug, entitlements } =
    await loadOrganizationPlanContext(organizationId);

  const allowed =
    feature === "auditLogs"
      ? entitlements.auditLogAccess
      : feature === "customRoles"
        ? entitlements.customRoles
        : feature === "securityCenter"
          ? entitlements.securityCenter
          : entitlements.integrations;

  if (!allowed) {
    throw new AppError(403, featureMessage(feature, planSlug), {
      code: "PLAN_FEATURE_UNAVAILABLE",
      details: {
        feature,
        planSlug,
        upgradePlanSlug: recommendedUpgradeForFeature(planSlug, feature),
      },
    });
  }

  return entitlements;
}

export function auditRetentionCutoff(
  entitlements: PlanEntitlements,
): Date | null {
  if (!entitlements.auditLogAccess) return null;
  if (entitlements.auditRetentionDays === null) return null;
  return new Date(
    Date.now() - entitlements.auditRetentionDays * 24 * 60 * 60 * 1000,
  );
}
