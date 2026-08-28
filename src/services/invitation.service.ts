import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import {
  Invitation,
  type InvitationStatus,
} from "../models/Invitation.model.js";
import { Membership } from "../models/Membership.model.js";
import { Organization } from "../models/Organization.model.js";
import { User } from "../models/User.model.js";
import type { CreateInvitationBody } from "../schemas/invitation.schemas.js";
import { sendOrganizationInviteEmail } from "./email.service.js";
import {
  getCurrentOrganizationForUser,
  type CurrentOrganizationResult,
} from "./organization.service.js";
import { assertPlanMemberCapacity } from "./planEntitlement.service.js";
import {
  assertAssignableRole,
  ensureOrganizationRoles,
  resolveRoleForMembership,
} from "./role.service.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationDto = {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  organization: {
    id: string;
    name: string;
  };
};

export type InvitationPreview = {
  usable: boolean;
  reason: "ok" | "expired" | "revoked" | "accepted" | "invalid";
  invitation: {
    email: string;
    roleId: string;
    roleName: string;
    expiresAt: Date;
    organization: {
      id: string;
      name: string;
    };
  } | null;
};

export type AcceptInvitationResult = CurrentOrganizationResult & {
  invitation: InvitationDto;
};

function inviteRoleName(invite: {
  roleName?: string | null;
  role?: string | null;
}): string {
  return invite.roleName || invite.role || "Member";
}

function toInvitationDto(
  invite: {
    _id: { toString(): string };
    email: string;
    roleId?: { toString(): string } | null;
    roleName?: string | null;
    role?: string | null;
    status: string;
    expiresAt: Date;
    createdAt: Date;
  },
  org: { _id: { toString(): string }; name: string },
): InvitationDto {
  return {
    id: invite._id.toString(),
    email: invite.email,
    roleId: invite.roleId?.toString() ?? "",
    roleName: inviteRoleName(invite),
    status: invite.status as InvitationStatus,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    organization: {
      id: org._id.toString(),
      name: org.name,
    },
  };
}

async function requireOrganization(organizationId: string) {
  const org = await Organization.findById(organizationId).lean();
  if (!org) {
    throw new AppError(404, "Organization not found", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  return org;
}

async function expireStalePendingInvites(organizationId: string): Promise<void> {
  await Invitation.updateMany(
    {
      organizationId,
      status: "pending",
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: "expired" } },
  );
}

async function findInvitationByRawToken(rawToken: string) {
  const tokenHash = hashToken(rawToken.trim());
  return Invitation.findOne({ tokenHash });
}

export async function createInvitationForOrganization(
  actorUserId: string,
  organizationId: string,
  body: CreateInvitationBody,
): Promise<InvitationDto> {
  const email = body.email;

  const actor = await User.findById(actorUserId).lean();
  if (!actor) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (actor.email.toLowerCase() === email) {
    throw new AppError(400, "You cannot invite yourself", {
      code: "CANNOT_INVITE_SELF",
    });
  }

  const org = await requireOrganization(organizationId);
  await ensureOrganizationRoles(organizationId);
  await expireStalePendingInvites(organizationId);
  await assertPlanMemberCapacity(organizationId, 1);

  // Only Owner / Admin may invite
  // member.invite was granted in the matrix (MVP rule).
  const actorMembership = await Membership.findOne({
    userId: actorUserId,
    organizationId,
  });
  if (!actorMembership) {
    throw new AppError(404, "No organization found for this account", {
      code: "NO_ORGANIZATION",
    });
  }
  const actorRole = await resolveRoleForMembership(actorMembership);
  if (actorRole.systemKey !== "owner" && actorRole.systemKey !== "admin") {
    throw new AppError(
      403,
      "Only Owner or Admin can invite members",
      { code: "FORBIDDEN" },
    );
  }

  const role = await assertAssignableRole({
    organizationId,
    roleId: body.roleId,
    disallowOwner: true,
  });

  const existingUser = await User.findOne({ email }).lean();
  if (existingUser) {
    const existingMembership = await Membership.findOne({
      organizationId,
      userId: existingUser._id,
    }).lean();
    if (existingMembership) {
      throw new AppError(409, "This person is already a member", {
        code: "ALREADY_MEMBER",
      });
    }
  }

  const pending = await Invitation.findOne({
    organizationId,
    email,
    status: "pending",
  }).lean();
  if (pending) {
    throw new AppError(409, "A pending invite already exists for this email", {
      code: "INVITE_ALREADY_PENDING",
    });
  }

  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invite = await Invitation.create({
    organizationId,
    email,
    roleId: role._id,
    roleName: role.name,
    role: role.systemKey ?? role.slug,
    tokenHash,
    invitedByUserId: actorUserId,
    status: "pending",
    expiresAt,
  });

  await sendOrganizationInviteEmail({
    to: email,
    inviterName: actor.name,
    organizationName: org.name,
    roleName: role.name,
    rawToken,
  });

  return toInvitationDto(invite, org);
}

export async function listPendingInvitationsForOrganization(
  organizationId: string,
): Promise<{ invitations: InvitationDto[] }> {
  const org = await requireOrganization(organizationId);
  await expireStalePendingInvites(organizationId);

  const invites = await Invitation.find({
    organizationId,
    status: "pending",
  })
    .sort({ createdAt: -1 })
    .lean();

  return {
    invitations: invites.map((invite) => toInvitationDto(invite, org)),
  };
}

export async function revokeInvitationForOrganization(
  organizationId: string,
  invitationId: string,
): Promise<InvitationDto> {
  if (!mongoose.isValidObjectId(invitationId)) {
    throw new AppError(400, "Invalid invitation id", {
      code: "INVALID_INVITATION_ID",
    });
  }

  const org = await requireOrganization(organizationId);
  const invite = await Invitation.findOne({
    _id: invitationId,
    organizationId,
  });
  if (!invite) {
    throw new AppError(404, "Invitation not found", {
      code: "INVITE_NOT_FOUND",
    });
  }

  if (invite.status !== "pending") {
    throw new AppError(409, "Only pending invitations can be revoked", {
      code: "INVITE_NOT_PENDING",
    });
  }

  invite.status = "revoked";
  await invite.save();
  return toInvitationDto(invite, org);
}

export async function resendInvitationForOrganization(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
): Promise<InvitationDto> {
  if (!mongoose.isValidObjectId(invitationId)) {
    throw new AppError(400, "Invalid invitation id", {
      code: "INVALID_INVITATION_ID",
    });
  }

  const actor = await User.findById(actorUserId).lean();
  if (!actor) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const org = await requireOrganization(organizationId);
  const invite = await Invitation.findOne({
    _id: invitationId,
    organizationId,
  });
  if (!invite) {
    throw new AppError(404, "Invitation not found", {
      code: "INVITE_NOT_FOUND",
    });
  }

  if (invite.status !== "pending") {
    throw new AppError(409, "Only pending invitations can be resent", {
      code: "INVITE_NOT_PENDING",
    });
  }

  if (invite.expiresAt.getTime() <= Date.now()) {
    invite.status = "expired";
    await invite.save();
    throw new AppError(410, "This invitation has expired. Send a new invite.", {
      code: "INVITE_EXPIRED",
    });
  }

  const rawToken = generateOpaqueToken();
  invite.tokenHash = hashToken(rawToken);
  invite.expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await invite.save();

  await sendOrganizationInviteEmail({
    to: invite.email,
    inviterName: actor.name,
    organizationName: org.name,
    roleName: inviteRoleName(invite),
    rawToken,
  });

  return toInvitationDto(invite, org);
}

export async function getInvitationPreviewByToken(
  rawToken: string,
): Promise<InvitationPreview> {
  const invite = await findInvitationByRawToken(rawToken);
  if (!invite) {
    return { usable: false, reason: "invalid", invitation: null };
  }

  const org = await Organization.findById(invite.organizationId).lean();
  if (!org) {
    return { usable: false, reason: "invalid", invitation: null };
  }

  const invitation = {
    email: invite.email,
    roleId: invite.roleId?.toString() ?? "",
    roleName: inviteRoleName(invite),
    expiresAt: invite.expiresAt,
    organization: {
      id: org._id.toString(),
      name: org.name,
    },
  };

  if (invite.status === "revoked") {
    return { usable: false, reason: "revoked", invitation };
  }
  if (invite.status === "accepted") {
    return { usable: false, reason: "accepted", invitation };
  }

  if (
    invite.status === "expired" ||
    invite.expiresAt.getTime() <= Date.now()
  ) {
    if (invite.status === "pending") {
      invite.status = "expired";
      await invite.save();
    }
    return { usable: false, reason: "expired", invitation };
  }

  return { usable: true, reason: "ok", invitation };
}

export async function acceptInvitationForUser(
  userId: string,
  rawToken: string,
): Promise<AcceptInvitationResult> {
  const invite = await findInvitationByRawToken(rawToken);
  if (!invite) {
    throw new AppError(404, "Invitation not found or invalid", {
      code: "INVITE_NOT_FOUND",
    });
  }
  return completeInvitationAcceptance(userId, invite);
}

export async function getPendingInvitationForUser(
  userId: string,
): Promise<{ invitation: InvitationDto | null }> {
  const user = await User.findById(userId).lean();
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const existingMembership = await Membership.findOne({ userId }).lean();
  if (existingMembership) {
    return { invitation: null };
  }

  await Invitation.updateMany(
    {
      email: user.email,
      status: "pending",
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: "expired" } },
  );

  const invite = await Invitation.findOne({
    email: user.email,
    status: "pending",
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!invite) return { invitation: null };

  const org = await Organization.findById(invite.organizationId).lean();
  if (!org) return { invitation: null };

  return { invitation: toInvitationDto(invite, org) };
}

export async function acceptPendingInvitationForUser(
  userId: string,
): Promise<AcceptInvitationResult> {
  const pending = await getPendingInvitationForUser(userId);
  if (!pending.invitation) {
    throw new AppError(404, "No pending invitation for this account", {
      code: "NO_PENDING_INVITE",
    });
  }

  const invite = await Invitation.findById(pending.invitation.id);
  if (!invite) {
    throw new AppError(404, "Invitation not found or invalid", {
      code: "INVITE_NOT_FOUND",
    });
  }

  return completeInvitationAcceptance(userId, invite);
}

async function completeInvitationAcceptance(
  userId: string,
  invite: InstanceType<typeof Invitation>,
): Promise<AcceptInvitationResult> {
  const user = await User.findById(userId).lean();
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (!user.emailVerified) {
    throw new AppError(403, "Verify your email before accepting an invite", {
      code: "EMAIL_NOT_VERIFIED",
    });
  }

  const existingMembership = await Membership.findOne({ userId }).lean();
  if (existingMembership) {
    throw new AppError(409, "You already belong to an organization", {
      code: "ALREADY_IN_ORGANIZATION",
    });
  }

  if (invite.status === "revoked") {
    throw new AppError(410, "This invitation was revoked", {
      code: "INVITE_REVOKED",
    });
  }
  if (invite.status === "accepted") {
    throw new AppError(409, "This invitation was already accepted", {
      code: "INVITE_ALREADY_ACCEPTED",
    });
  }
  if (
    invite.status === "expired" ||
    invite.expiresAt.getTime() <= Date.now()
  ) {
    if (invite.status === "pending") {
      invite.status = "expired";
      await invite.save();
    }
    throw new AppError(410, "This invitation has expired", {
      code: "INVITE_EXPIRED",
    });
  }

  if (user.email.toLowerCase() !== invite.email) {
    throw new AppError(
      403,
      "Sign in with the email address this invite was sent to",
      {
        code: "INVITE_EMAIL_MISMATCH",
        details: { invitedEmail: invite.email },
      },
    );
  }

  const org = await requireOrganization(invite.organizationId.toString());
  await assertPlanMemberCapacity(invite.organizationId.toString(), 1);
  await ensureOrganizationRoles(invite.organizationId.toString());

  let roleId = invite.roleId;
  if (!roleId) {
    const system = await ensureOrganizationRoles(
      invite.organizationId.toString(),
    );
    roleId = system.admin._id;
  }

  const role = await assertAssignableRole({
    organizationId: invite.organizationId.toString(),
    roleId: roleId.toString(),
    disallowOwner: true,
  });

  try {
    await Membership.create({
      organizationId: invite.organizationId,
      userId,
      roleId: role._id,
      role: role.systemKey ?? undefined,
      status: "active",
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(409, "You already belong to an organization", {
        code: "ALREADY_IN_ORGANIZATION",
      });
    }
    throw err;
  }

  invite.status = "accepted";
  invite.acceptedAt = new Date();
  invite.acceptedByUserId = new mongoose.Types.ObjectId(userId);
  invite.roleId = role._id;
  invite.roleName = role.name;
  await invite.save();

  await User.updateOne(
    { _id: userId },
    { $set: { reinviteRequired: false } },
  );

  const current = await getCurrentOrganizationForUser(userId);
  return {
    ...current,
    invitation: toInvitationDto(invite, org),
  };
}
