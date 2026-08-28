import { AppError } from "../lib/errors/AppError.js";
import { planDisplayName, type PlanSlug } from "../lib/subscriptionPlans.js";
import { slugifyOrganizationName } from "../lib/slugify.js";
import type { Permission } from "../lib/permissions.js";
import { Membership } from "../models/Membership.model.js";
import { Organization } from "../models/Organization.model.js";
import type { UserDocument } from "../models/User.model.js";
import {
  applyPlanAtSignup,
  subscriptionSnapshot,
  type SubscriptionSnapshot,
} from "./subscription.service.js";
import {
  ensureOrganizationRoles,
  getSystemRoleId,
  type ResolvedOrgRole,
} from "./role.service.js";

/**
 * New workspaces must have exactly one membership — the registering user as Owner.
 * Admin is a role template until someone is invited into it.
 */
export async function assertSingleOwnerBootstrap(
  organizationId: string,
): Promise<void> {
  const memberCount = await Membership.countDocuments({ organizationId });
  if (memberCount !== 1) {
    throw new AppError(
      500,
      "Organization membership bootstrap failed",
      { code: "INTERNAL_ERROR", isOperational: false },
    );
  }

  const ownerRoleId = await getSystemRoleId(organizationId, "owner");
  const ownerMembers = await Membership.countDocuments({
    organizationId,
    roleId: ownerRoleId,
  });
  if (ownerMembers !== 1) {
    throw new AppError(
      500,
      "Organization owner bootstrap failed",
      { code: "INTERNAL_ERROR", isOperational: false },
    );
  }
}

async function allocateUniqueSlug(name: string): Promise<string> {
  const base = slugifyOrganizationName(name);
  let candidate = base;
  let attempt = 0;

  while (attempt < 20) {
    const exists = await Organization.exists({ slug: candidate });
    if (!exists) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  return `${base}-${Date.now().toString(36)}`;
}

export type SignupOrganizationResult = {
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    planSlug: PlanSlug;
    subscriptionStatus: string;
    trialEndsAt: Date | null;
    currentPeriodEndsAt: Date | null;
  };
  role: ResolvedOrgRole;
  permissions: Permission[];
  subscription: SubscriptionSnapshot;
};

/**
 * Creates company workspace at signup (company name from registration form).
 * Exactly one membership is created: the registering user as Owner.
 * Admin is a role template only until the Owner invites someone into it.
 */
export async function createOrganizationAtSignup(
  user: UserDocument,
  companyName: string,
  planSlug: PlanSlug,
  phone?: string,
): Promise<SignupOrganizationResult> {
  const existing = await Membership.findOne({ userId: user._id }).lean();
  if (existing) {
    throw new AppError(409, "You already belong to an organization", {
      code: "ALREADY_IN_ORGANIZATION",
    });
  }

  const slug = await allocateUniqueSlug(companyName);
  const organization = await Organization.create({
    name: companyName.trim(),
    slug,
    type: "other",
    phone: phone?.trim() || "—",
    plan: planDisplayName(planSlug),
    planSlug,
    subscriptionStatus: "pending_payment",
  });

  applyPlanAtSignup(organization, planSlug);
  await organization.save();

  const system = await ensureOrganizationRoles(organization._id.toString());
  await Membership.create({
    organizationId: organization._id,
    userId: user._id,
    roleId: system.owner._id,
    role: "owner",
  });

  await assertSingleOwnerBootstrap(organization._id.toString());

  const subscription = subscriptionSnapshot(organization);
  const permissions = [...(system.owner.permissions as Permission[])];

  return {
    organization: {
      id: organization._id.toString(),
      name: organization.name,
      slug: organization.slug,
      plan: organization.plan ?? subscription.planLabel,
      planSlug: subscription.planSlug,
      subscriptionStatus: subscription.subscriptionStatus,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEndsAt: subscription.currentPeriodEndsAt,
    },
    role: {
      roleId: system.owner._id.toString(),
      name: system.owner.name,
      systemKey: "owner",
      permissions,
      kind: "system",
    },
    permissions,
    subscription,
  };
}
