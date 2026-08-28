import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import {
  permissionsInclude,
  type Permission,
} from "../lib/permissions.js";
import { slugifyOrganizationName } from "../lib/slugify.js";
import {
  Membership,
  type MembershipStatus,
} from "../models/Membership.model.js";
import {
  Organization,
  type CompanySize,
  type OrganizationType,
} from "../models/Organization.model.js";
import { Invitation } from "../models/Invitation.model.js";
import { User } from "../models/User.model.js";
import type { PlanSlug, SubscriptionStatus, BillingInterval } from "../lib/subscriptionPlans.js";
import { planDisplayName } from "../lib/subscriptionPlans.js";
import type {
  CreateOrganizationBody,
  UpdateOrganizationBody,
} from "../schemas/organization.schemas.js";
import {
  activateOrganizationSubscription,
  applyPlanAtSignup,
  assertActiveSubscription,
  extendOrganizationTrial,
  subscriptionSnapshot,
  trialBonusDaysRemaining,
  updateAutoRenewSettings,
} from "./subscription.service.js";
import {
  assertSingleOwnerBootstrap,
} from "./signup.service.js";
import { logoutAllSessions, destroyAllSessions } from "./auth.service.js";
import { AccessRequest } from "../models/AccessRequest.model.js";
import { Notification } from "../models/Notification.model.js";
import {
  assertAssignableRole,
  ensureOrganizationRoles,
  listRolesForOrganization,
  resolveRoleForMembership,
  type ResolvedOrgRole,
  type RoleDto,
} from "./role.service.js";

export type OrganizationDto = {
  id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  phone: string;
  plan: string;
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
  daysUntilExpiry: number | null;
  website: string | null;
  country: string | null;
  companySize: CompanySize | null;
  industry: string | null;
  billingEmail: string | null;
  address: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: Date;
};

export type MemberRoleRef = {
  id: string;
  name: string;
  systemKey: string | null;
};

export type MembershipDto = {
  id: string;
  role: MemberRoleRef;
  status: MembershipStatus;
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    mfaEnabled: boolean;
  };
  createdAt: Date;
};

export type CurrentOrganizationResult = {
  organization: OrganizationDto;
  role: ResolvedOrgRole;
  permissions: Permission[];
};

export type RolesMatrixResult = {
  roles: RoleDto[];
  permissionCatalog: Permission[];
  matrix: Record<string, Permission[]>;
  yourRoleId: string;
  yourRoleName: string;
  yourSystemKey: string | null;
  yourPermissions: Permission[];
};

function toOrganizationDto(org: {
  _id: { toString(): string };
  name: string;
  slug: string;
  type?: string | null;
  phone?: string | null;
  plan?: string | null;
  planSlug?: string | null;
  subscriptionStatus?: string | null;
  billingInterval?: string | null;
  subscriptionAmountCents?: number | null;
  currency?: string | null;
  autoRenew?: boolean | null;
  autoRenewInterval?: string | null;
  trialEndsAt?: Date | null;
  currentPeriodEndsAt?: Date | null;
  trialBonusDaysGranted?: number | null;
  website?: string | null;
  country?: string | null;
  companySize?: string | null;
  industry?: string | null;
  billingEmail?: string | null;
  address?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  createdAt: Date;
}): OrganizationDto {
  const snap = subscriptionSnapshot(org as never);
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    type: (org.type as OrganizationType) ?? "other",
    phone: org.phone ?? "",
    plan: org.plan ?? "Starter",
    planSlug: snap.planSlug,
    subscriptionStatus: snap.subscriptionStatus,
    billingInterval: snap.billingInterval,
    subscriptionAmountCents: snap.subscriptionAmountCents,
    currency: snap.currency,
    autoRenew: snap.autoRenew,
    autoRenewInterval: snap.autoRenewInterval,
    trialEndsAt: snap.trialEndsAt,
    currentPeriodEndsAt: snap.currentPeriodEndsAt,
    trialBonusDaysGranted: snap.trialBonusDaysGranted,
    daysUntilExpiry: snap.daysUntilExpiry,
    website: org.website ?? null,
    country: org.country ?? null,
    companySize: (org.companySize as CompanySize | null) ?? null,
    industry: org.industry ?? null,
    billingEmail: org.billingEmail ?? null,
    address: org.address ?? null,
    cardBrand: org.cardBrand ?? null,
    cardLast4: org.cardLast4 ?? null,
    createdAt: org.createdAt,
  };
}

function withResolvedRole(
  organization: OrganizationDto,
  resolved: ResolvedOrgRole,
): CurrentOrganizationResult {
  return {
    organization,
    role: resolved,
    permissions: [...resolved.permissions],
  };
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

export async function loadMembershipContext(userId: string) {
  const membership = await Membership.findOne({ userId });
  if (!membership) {
    throw new AppError(404, "No organization found for this account", {
      code: "NO_ORGANIZATION",
    });
  }
  const resolved = await resolveRoleForMembership(membership);
  if (!membership.roleId || membership.roleId.toString() !== resolved.roleId) {
    membership.roleId = new mongoose.Types.ObjectId(resolved.roleId);
    await membership.save();
  }
  return { membership, resolved };
}

/**
 * MVP: a user may create at most one organization (as owner).
 */
export async function createOrganizationForUser(
  userId: string,
  input: CreateOrganizationBody,
): Promise<CurrentOrganizationResult> {
  const user = await User.findById(userId).select("reinviteRequired").lean();
  if (user?.reinviteRequired) {
    throw new AppError(
      403,
      "Your previous workspace access was removed. Open a new invitation email to join again — you cannot create a new organization from this account.",
      { code: "REINVITE_REQUIRED" },
    );
  }

  const existing = await Membership.findOne({ userId }).lean();
  if (existing) {
    throw new AppError(409, "You already belong to an organization", {
      code: "ALREADY_IN_ORGANIZATION",
    });
  }

  const slug = await allocateUniqueSlug(input.name);
  const organization = await Organization.create({
    name: input.name.trim(),
    slug,
    type: input.type ?? "other",
    phone: (input.phone ?? "—").trim() || "—",
    plan: planDisplayName("free"),
    planSlug: "free",
    subscriptionStatus: "pending_payment",
  });

  applyPlanAtSignup(organization, "free");
  await organization.save();

  const system = await ensureOrganizationRoles(organization._id.toString());
  await Membership.create({
    organizationId: organization._id,
    userId,
    roleId: system.owner._id,
    role: "owner",
  });

  await assertSingleOwnerBootstrap(organization._id.toString());

  return withResolvedRole(toOrganizationDto(organization), {
    roleId: system.owner._id.toString(),
    name: system.owner.name,
    systemKey: "owner",
    permissions: [...(system.owner.permissions as Permission[])],
    kind: "system",
  });
}

export async function getCurrentOrganizationForUser(
  userId: string,
): Promise<CurrentOrganizationResult> {
  const { membership, resolved } = await loadMembershipContext(userId);

  if ((membership.status ?? "active") === "disabled") {
    throw new AppError(
      403,
      "Your account has been disabled by an organization admin",
      { code: "MEMBER_DISABLED" },
    );
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  await assertActiveSubscription(organization);

  return withResolvedRole(toOrganizationDto(organization), resolved);
}

export async function updateCurrentOrganizationForUser(
  userId: string,
  input: UpdateOrganizationBody,
): Promise<CurrentOrganizationResult> {
  const { membership, resolved } = await loadMembershipContext(userId);

  if (!permissionsInclude(resolved.permissions, "org.update")) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission: "org.update" },
    });
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  if (input.name !== undefined) organization.name = input.name;
  if (input.type !== undefined) organization.type = input.type;
  if (input.phone !== undefined) organization.phone = input.phone;
  if (input.website !== undefined) organization.website = input.website;
  if (input.country !== undefined) organization.country = input.country;
  if (input.companySize !== undefined) {
    organization.companySize = input.companySize;
  }
  if (input.industry !== undefined) organization.industry = input.industry;
  if (input.billingEmail !== undefined) {
    organization.billingEmail = input.billingEmail;
  }
  if (input.address !== undefined) organization.address = input.address;

  await organization.save();

  return withResolvedRole(toOrganizationDto(organization), resolved);
}

export async function listCurrentOrganizationMembers(
  userId: string,
): Promise<{ organizationId: string; members: MembershipDto[] }> {
  const { organization } = await getCurrentOrganizationForUser(userId);
  await ensureOrganizationRoles(organization.id);

  const rows = await Membership.find({ organizationId: organization.id })
    .sort({ createdAt: 1 })
    .lean();

  const userIds = rows.map((row) => row.userId);
  const users = await User.find({ _id: { $in: userIds } })
    .select("name email emailVerified mfaEnabled")
    .lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const members: MembershipDto[] = [];
  for (const row of rows) {
    const user = userById.get(row.userId.toString());
    if (!user) continue;
    const resolved = await resolveRoleForMembership(row);
    members.push({
      id: row._id.toString(),
      role: {
        id: resolved.roleId,
        name: resolved.name,
        systemKey: resolved.systemKey,
      },
      status: ((row as { status?: MembershipStatus }).status ??
        "active") as MembershipStatus,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled ?? false,
      },
      createdAt: row.createdAt,
    });
  }

  return { organizationId: organization.id, members };
}

/**
 * Change a member's role by roleId. Owner role is not assignable.
 */
export async function updateMemberRoleForOrganization(
  actorUserId: string,
  organizationId: string,
  membershipId: string,
  nextRoleId: string,
): Promise<MembershipDto> {
  if (!mongoose.isValidObjectId(membershipId)) {
    throw new AppError(400, "Invalid membership id", {
      code: "INVALID_MEMBERSHIP_ID",
    });
  }

  const actorMembership = await Membership.findOne({
    userId: actorUserId,
    organizationId,
  });
  if (!actorMembership) {
    throw new AppError(404, "No organization found for this account", {
      code: "NO_ORGANIZATION",
    });
  }

  const actorResolved = await resolveRoleForMembership(actorMembership);
  if (!permissionsInclude(actorResolved.permissions, "member.role.update")) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission: "member.role.update" },
    });
  }

  const target = await Membership.findOne({
    _id: membershipId,
    organizationId,
  });
  if (!target) {
    throw new AppError(404, "Member not found in this organization", {
      code: "MEMBER_NOT_FOUND",
    });
  }

  if (target.userId.toString() === actorUserId) {
    throw new AppError(400, "You cannot change your own role", {
      code: "CANNOT_CHANGE_OWN_ROLE",
    });
  }

  const targetResolved = await resolveRoleForMembership(target);
  if (targetResolved.systemKey === "owner") {
    throw new AppError(403, "The organization owner role cannot be changed", {
      code: "CANNOT_CHANGE_OWNER",
    });
  }

  const nextRole = await assertAssignableRole({
    organizationId,
    roleId: nextRoleId,
    disallowOwner: true,
  });

  target.roleId = nextRole._id;
  target.role = nextRole.systemKey ?? undefined;
  await target.save();

  return toMembershipDto(target);
}

/**
 * Remove a member from the organization (not the owner, not yourself).
 */
export async function removeMemberFromOrganization(
  actorUserId: string,
  organizationId: string,
  membershipId: string,
): Promise<{ removedMembershipId: string }> {
  const target = await loadManageableTargetMembership(
    actorUserId,
    organizationId,
    membershipId,
    "member.remove",
  );

  const targetUser = await User.findById(target.userId).select("email");
  const targetUserId = target.userId.toString();
  const email = targetUser?.email?.toLowerCase();

  await Membership.deleteOne({ _id: target._id });

  // Kill every session so they are signed out immediately.
  await destroyAllSessions(targetUserId);

  if (targetUser) {
    targetUser.reinviteRequired = true;
    await targetUser.save();
  }

  // Old invites must not work — only a brand-new invite can restore access.
  if (email) {
    await Invitation.updateMany(
      {
        organizationId,
        email,
        status: { $in: ["pending", "accepted", "revoked", "expired"] },
      },
      {
        $set: {
          status: "expired",
          expiresAt: new Date(0),
        },
      },
    );
  }

  // Org-scoped personal rows for this member (not audit history).
  await Promise.all([
    AccessRequest.deleteMany({
      organizationId,
      requesterUserId: targetUserId,
    }),
    Notification.deleteMany({
      organizationId,
      userId: targetUserId,
    }),
  ]);

  return { removedMembershipId: membershipId };
}

async function loadManageableTargetMembership(
  actorUserId: string,
  organizationId: string,
  membershipId: string,
  permission: "member.disable" | "member.remove",
) {
  if (!mongoose.isValidObjectId(membershipId)) {
    throw new AppError(400, "Invalid membership id", {
      code: "INVALID_MEMBERSHIP_ID",
    });
  }

  const actorMembership = await Membership.findOne({
    userId: actorUserId,
    organizationId,
  });
  if (!actorMembership) {
    throw new AppError(404, "No organization found for this account", {
      code: "NO_ORGANIZATION",
    });
  }

  const actorResolved = await resolveRoleForMembership(actorMembership);
  if (!permissionsInclude(actorResolved.permissions, permission)) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission },
    });
  }

  const target = await Membership.findOne({
    _id: membershipId,
    organizationId,
  });
  if (!target) {
    throw new AppError(404, "Member not found in this organization", {
      code: "MEMBER_NOT_FOUND",
    });
  }

  if (target.userId.toString() === actorUserId) {
    throw new AppError(400, "You cannot change your own access this way", {
      code: "CANNOT_MANAGE_SELF",
    });
  }

  const targetResolved = await resolveRoleForMembership(target);
  if (targetResolved.systemKey === "owner") {
    throw new AppError(403, "The organization owner cannot be managed this way", {
      code: "CANNOT_MANAGE_OWNER",
    });
  }

  return target;
}

async function toMembershipDto(
  membership: InstanceType<typeof Membership>,
): Promise<MembershipDto> {
  const user = await User.findById(membership.userId)
    .select("name email emailVerified mfaEnabled")
    .lean();
  if (!user) {
    throw new AppError(404, "User no longer exists", {
      code: "USER_NOT_FOUND",
    });
  }

  const resolved = await resolveRoleForMembership(membership);

  return {
    id: membership._id.toString(),
    role: {
      id: resolved.roleId,
      name: resolved.name,
      systemKey: resolved.systemKey,
    },
    status: ((membership.status ?? "active") as MembershipStatus),
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled ?? false,
    },
    createdAt: membership.createdAt,
  };
}

export async function disableMemberInOrganization(
  actorUserId: string,
  organizationId: string,
  membershipId: string,
): Promise<MembershipDto> {
  const target = await loadManageableTargetMembership(
    actorUserId,
    organizationId,
    membershipId,
    "member.disable",
  );

  if ((target.status ?? "active") === "disabled") {
    return toMembershipDto(target);
  }

  target.status = "disabled";
  await target.save();
  await logoutAllSessions(target.userId.toString());
  return toMembershipDto(target);
}

export async function enableMemberInOrganization(
  actorUserId: string,
  organizationId: string,
  membershipId: string,
): Promise<MembershipDto> {
  const target = await loadManageableTargetMembership(
    actorUserId,
    organizationId,
    membershipId,
    "member.disable",
  );

  if ((target.status ?? "active") === "active") {
    return toMembershipDto(target);
  }

  target.status = "active";
  await target.save();
  return toMembershipDto(target);
}

/** Roles list + matrix for the Roles & Permissions UI. */
export async function getRolesMatrixForUser(
  userId: string,
): Promise<RolesMatrixResult> {
  const current = await getCurrentOrganizationForUser(userId);
  const { roles, permissionCatalog } = await listRolesForOrganization(
    current.organization.id,
  );

  const matrix: Record<string, Permission[]> = {};
  for (const role of roles) {
    matrix[role.id] = role.permissions;
  }

  return {
    roles,
    permissionCatalog,
    matrix,
    yourRoleId: current.role.roleId,
    yourRoleName: current.role.name,
    yourSystemKey: current.role.systemKey,
    yourPermissions: current.permissions,
  };
}

export type ExtendTrialResult = CurrentOrganizationResult & {
  trialExtension: {
    daysAdded: number;
    trialEndsAt: Date | null;
    bonusDaysGranted: number;
    bonusDaysRemaining: number;
  };
};

export type TrialSummaryResult = {
  role: ResolvedOrgRole;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  bonusDaysGranted: number;
  bonusDaysRemaining: number;
  canExtendTrial: boolean;
};

export async function getTrialSummaryForUser(
  userId: string,
): Promise<TrialSummaryResult> {
  const { membership, resolved } = await loadMembershipContext(userId);

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  const bonusRemaining = trialBonusDaysRemaining(organization);

  return {
    role: resolved,
    subscriptionStatus:
      (organization.subscriptionStatus ?? "pending_payment") as SubscriptionStatus,
    trialEndsAt: organization.trialEndsAt ?? null,
    bonusDaysGranted: organization.trialBonusDaysGranted ?? 0,
    bonusDaysRemaining: bonusRemaining,
    canExtendTrial: resolved.systemKey === "owner" && bonusRemaining > 0,
  };
}

export async function extendTrialForCurrentOrganization(
  userId: string,
  days: number,
): Promise<ExtendTrialResult> {
  const { membership, resolved } = await loadMembershipContext(userId);

  if (resolved.systemKey !== "owner") {
    throw new AppError(403, "Only the workspace owner can extend the free trial", {
      code: "FORBIDDEN",
      details: { roleId: resolved.roleId },
    });
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  const updated = await extendOrganizationTrial(organization, days);

  return {
    ...withResolvedRole(toOrganizationDto(updated), resolved),
    trialExtension: {
      daysAdded: days,
      trialEndsAt: updated.trialEndsAt ?? null,
      bonusDaysGranted: updated.trialBonusDaysGranted ?? 0,
      bonusDaysRemaining: trialBonusDaysRemaining(updated),
    },
  };
}

/**
 * Billing status without workspace gate — used on trial-ended / checkout screens.
 */
export async function getSubscriptionBillingForUser(userId: string) {
  const { membership, resolved } = await loadMembershipContext(userId);
  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  return {
    role: resolved,
    subscription: subscriptionSnapshot(organization),
    organization: toOrganizationDto(organization),
  };
}

export async function activateSubscriptionForUser(
  userId: string,
  planSlug: PlanSlug,
  interval: BillingInterval,
): Promise<CurrentOrganizationResult> {
  if (env.lemonSqueezy.configured) {
    throw new AppError(
      400,
      "Use secure card checkout to activate a paid plan.",
      { code: "USE_BILLING_CHECKOUT" },
    );
  }

  const { membership, resolved } = await loadMembershipContext(userId);

  if (resolved.systemKey !== "owner" && resolved.systemKey !== "admin") {
    throw new AppError(403, "Only owners or admins can activate a plan", {
      code: "FORBIDDEN",
    });
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  const updated = await activateOrganizationSubscription(
    organization,
    planSlug,
    interval,
  );

  return withResolvedRole(toOrganizationDto(updated), resolved);
}

export async function updateAutoRenewForUser(
  userId: string,
  input: { autoRenew: boolean; autoRenewInterval?: BillingInterval | null },
): Promise<CurrentOrganizationResult> {
  const { membership, resolved } = await loadMembershipContext(userId);

  if (resolved.systemKey !== "owner" && resolved.systemKey !== "admin") {
    throw new AppError(403, "Only owners or admins can change auto-renew", {
      code: "FORBIDDEN",
    });
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  const updated = await updateAutoRenewSettings(organization, input);

  try {
    const { syncAutoRenewToLemon } = await import("./billing.service.js");
    await syncAutoRenewToLemon(updated, input.autoRenew);
  } catch {
    // Lemon sync failure should not block local preference; webhooks will reconcile.
  }

  return withResolvedRole(toOrganizationDto(updated), resolved);
}
