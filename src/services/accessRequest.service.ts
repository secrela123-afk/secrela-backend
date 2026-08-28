import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import {
  AccessRequest,
  type AccessDurationMinutes,
  type AccessRequestStatus,
} from "../models/AccessRequest.model.js";
import { Membership } from "../models/Membership.model.js";
import { Secret } from "../models/Secret.model.js";
import { User } from "../models/User.model.js";
import { Vault } from "../models/Vault.model.js";
import type {
  CreateAccessRequestBody,
  ReviewAccessRequestBody,
} from "../schemas/accessRequest.schemas.js";
import {
  createNotificationsForUsers,
  notifyOwnersAndAdmins,
} from "./notification.service.js";
import { resolveRoleForMembership } from "./role.service.js";

async function assertRequesterIsNotOwnerOrAdmin(
  organizationId: string,
  userId: string,
): Promise<InstanceType<typeof Membership>> {
  const membership = await Membership.findOne({ organizationId, userId });
  if (!membership) {
    throw new AppError(404, "No organization found for this account", {
      code: "NO_ORGANIZATION",
    });
  }
  const resolved = await resolveRoleForMembership(membership);
  if (resolved.systemKey === "owner" || resolved.systemKey === "admin") {
    throw new AppError(
      403,
      "Owners and Admins already have secret access — they cannot create access requests",
      { code: "OWNER_ADMIN_CANNOT_REQUEST" },
    );
  }
  return membership;
}

const ACCESS_REQUEST_DENIAL_LIMIT = 3;
const ACCESS_REQUEST_BLOCK_MS = 24 * 60 * 60 * 1000;

export async function getAccessRequestBlockStatus(
  organizationId: string,
  userId: string,
): Promise<{
  blocked: boolean;
  blockedUntil: Date | null;
  consecutiveDenials: number;
}> {
  const membership = await Membership.findOne({ organizationId, userId }).lean();
  if (!membership) {
    return { blocked: false, blockedUntil: null, consecutiveDenials: 0 };
  }
  const until = membership.accessRequestBlockedUntil ?? null;
  const consecutive = membership.accessRequestConsecutiveDenials ?? 0;

  if (until && new Date(until).getTime() > Date.now()) {
    return {
      blocked: true,
      blockedUntil: new Date(until),
      consecutiveDenials: consecutive,
    };
  }

  if (until && new Date(until).getTime() <= Date.now()) {
    await Membership.updateOne(
      { _id: membership._id },
      {
        $set: {
          accessRequestBlockedUntil: null,
          accessRequestConsecutiveDenials: 0,
        },
      },
    );
    return { blocked: false, blockedUntil: null, consecutiveDenials: 0 };
  }

  return {
    blocked: false,
    blockedUntil: null,
    consecutiveDenials: consecutive,
  };
}

async function assertNotBlocked(
  organizationId: string,
  userId: string,
): Promise<void> {
  const status = await getAccessRequestBlockStatus(organizationId, userId);
  if (status.blocked && status.blockedUntil) {
    throw new AppError(
      429,
      "Access requests are temporarily blocked after repeated denials. Try again later.",
      {
        code: "ACCESS_REQUEST_BLOCKED",
        details: { blockedUntil: status.blockedUntil.toISOString() },
      },
    );
  }
}

export type AccessRequestDto = {
  id: string;
  status: AccessRequestStatus;
  permission: "use";
  durationMinutes: number;
  reason: string;
  reviewNote: string;
  requestedAt: Date;
  reviewedAt: Date | null;
  grantedAt: Date | null;
  expiresAt: Date | null;
  remainingMs: number | null;
  requester: { id: string; name: string; initials: string };
  reviewer: { id: string; name: string } | null;
  secret: {
    id: string;
    name: string;
    vault: { id: string; name: string };
  };
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function remainingMs(expiresAt: Date | null | undefined): number | null {
  if (!expiresAt) return null;
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

/** Mark approved grants past expiresAt as expired (lazy). */
export async function expireStaleGrants(
  organizationId: string,
): Promise<number> {
  const result = await AccessRequest.updateMany(
    {
      organizationId,
      status: "approved",
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: "expired" } },
  );
  return result.modifiedCount;
}

async function toDto(
  row: {
    _id: { toString(): string };
    status: string;
    permission?: string;
    durationMinutes: number;
    reason: string;
    reviewNote?: string | null;
    createdAt: Date;
    reviewedAt?: Date | null;
    grantedAt?: Date | null;
    expiresAt?: Date | null;
    requesterUserId: { toString(): string };
    reviewedByUserId?: { toString(): string } | null;
    secretId: { toString(): string };
  },
  secretById: Map<
    string,
    { name: string; vaultId: string; vaultName: string }
  >,
  userById: Map<string, { name: string }>,
): Promise<AccessRequestDto> {
  const secretId = row.secretId.toString();
  const secret = secretById.get(secretId);
  const requesterId = row.requesterUserId.toString();
  const requesterName = userById.get(requesterId)?.name ?? "Unknown";
  const reviewerId = row.reviewedByUserId?.toString() ?? null;
  const reviewerName = reviewerId
    ? userById.get(reviewerId)?.name ?? null
    : null;

  return {
    id: row._id.toString(),
    status: row.status as AccessRequestStatus,
    permission: "use",
    durationMinutes: row.durationMinutes,
    reason: row.reason,
    reviewNote: row.reviewNote ?? "",
    requestedAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null,
    grantedAt: row.grantedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    remainingMs: remainingMs(row.expiresAt ?? null),
    requester: {
      id: requesterId,
      name: requesterName,
      initials: initials(requesterName) || "?",
    },
    reviewer: reviewerId && reviewerName
      ? { id: reviewerId, name: reviewerName }
      : null,
    secret: {
      id: secretId,
      name: secret?.name ?? "Unknown secret",
      vault: {
        id: secret?.vaultId ?? "",
        name: secret?.vaultName ?? "Unknown vault",
      },
    },
  };
}

async function hydrateDtos(
  organizationId: string,
  rows: Array<{
    _id: { toString(): string };
    status: string;
    permission?: string;
    durationMinutes: number;
    reason: string;
    reviewNote?: string | null;
    createdAt: Date;
    reviewedAt?: Date | null;
    grantedAt?: Date | null;
    expiresAt?: Date | null;
    requesterUserId: { toString(): string };
    reviewedByUserId?: { toString(): string } | null;
    secretId: { toString(): string };
  }>,
): Promise<AccessRequestDto[]> {
  const secretIds = [...new Set(rows.map((r) => r.secretId.toString()))];
  const userIds = [
    ...new Set(
      rows.flatMap((r) => {
        const ids = [r.requesterUserId.toString()];
        if (r.reviewedByUserId) ids.push(r.reviewedByUserId.toString());
        return ids;
      }),
    ),
  ];

  const [secrets, users] = await Promise.all([
    Secret.find({ _id: { $in: secretIds }, organizationId })
      .select("name vaultId")
      .lean(),
    User.find({ _id: { $in: userIds } }).select("name").lean(),
  ]);

  const vaultIds = [...new Set(secrets.map((s) => s.vaultId.toString()))];
  const vaults = await Vault.find({
    _id: { $in: vaultIds },
    organizationId,
  })
    .select("name")
    .lean();
  const vaultNameById = new Map(
    vaults.map((v) => [v._id.toString(), v.name]),
  );

  const secretById = new Map(
    secrets.map((s) => [
      s._id.toString(),
      {
        name: s.name,
        vaultId: s.vaultId.toString(),
        vaultName: vaultNameById.get(s.vaultId.toString()) ?? "Unknown vault",
      },
    ]),
  );
  const userById = new Map(
    users.map((u) => [u._id.toString(), { name: u.name }]),
  );

  const dtos: AccessRequestDto[] = [];
  for (const row of rows) {
    dtos.push(await toDto(row, secretById, userById));
  }
  return dtos;
}

export async function listAccessRequestsForOrganization(
  organizationId: string,
): Promise<{
  requests: AccessRequestDto[];
  summary: {
    pending: number;
    approved: number;
    denied: number;
    expired: number;
    revoked: number;
  };
}> {
  await expireStaleGrants(organizationId);
  const rows = await AccessRequest.find({ organizationId })
    .sort({ createdAt: -1 })
    .lean();
  const requests = await hydrateDtos(organizationId, rows);

  const summary = {
    pending: 0,
    approved: 0,
    denied: 0,
    expired: 0,
    revoked: 0,
  };
  for (const r of requests) {
    if (r.status in summary) {
      summary[r.status as keyof typeof summary] += 1;
    }
  }

  return { requests, summary };
}

export async function createAccessRequestForOrganization(
  organizationId: string,
  requesterUserId: string,
  body: CreateAccessRequestBody,
): Promise<AccessRequestDto> {
  await expireStaleGrants(organizationId);
  await assertRequesterIsNotOwnerOrAdmin(organizationId, requesterUserId);
  await assertNotBlocked(organizationId, requesterUserId);

  if (!mongoose.isValidObjectId(body.secretId)) {
    throw new AppError(400, "Invalid secret id", { code: "INVALID_SECRET_ID" });
  }

  const secret = await Secret.findOne({
    _id: body.secretId,
    organizationId,
  });
  if (!secret) {
    throw new AppError(404, "Secret not found", { code: "SECRET_NOT_FOUND" });
  }

  const existingPending = await AccessRequest.findOne({
    organizationId,
    requesterUserId,
    secretId: body.secretId,
    status: "pending",
  });
  if (existingPending) {
    throw new AppError(
      409,
      "You already have a pending request for this secret",
      { code: "ACCESS_REQUEST_PENDING" },
    );
  }

  const activeGrant = await AccessRequest.findOne({
    organizationId,
    requesterUserId,
    secretId: body.secretId,
    status: "approved",
    expiresAt: { $gt: new Date() },
  });
  if (activeGrant) {
    throw new AppError(
      409,
      "You already have active temporary access to this secret",
      { code: "ACCESS_ALREADY_GRANTED" },
    );
  }

  const row = await AccessRequest.create({
    organizationId,
    requesterUserId,
    secretId: body.secretId,
    permission: body.permission ?? "use",
    durationMinutes: body.durationMinutes as AccessDurationMinutes,
    reason: body.reason.trim(),
    status: "pending",
  });

  const lean = await AccessRequest.findById(row._id).lean();
  if (!lean) {
    throw new AppError(500, "Access request created but could not be loaded", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  const [dto] = await hydrateDtos(organizationId, [lean]);

  const requesterName = dto!.requester.name;
  await notifyOwnersAndAdmins({
    organizationId,
    type: "access_request.created",
    title: "New access request",
    body: `${requesterName} requested access to “${dto!.secret.name}” for ${dto!.durationMinutes} minutes.`,
    href: "/app/access-requests",
    meta: {
      requestId: dto!.id,
      secretId: dto!.secret.id,
      secretName: dto!.secret.name,
    },
    excludeUserId: requesterUserId,
  });

  return dto!;
}

export async function approveAccessRequestForOrganization(
  organizationId: string,
  reviewerUserId: string,
  requestId: string,
  body: ReviewAccessRequestBody,
): Promise<AccessRequestDto> {
  await expireStaleGrants(organizationId);

  if (!mongoose.isValidObjectId(requestId)) {
    throw new AppError(400, "Invalid request id", {
      code: "INVALID_ACCESS_REQUEST_ID",
    });
  }

  const row = await AccessRequest.findOne({
    _id: requestId,
    organizationId,
  });
  if (!row) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  if (row.status !== "pending") {
    throw new AppError(409, "Only pending requests can be approved", {
      code: "ACCESS_REQUEST_NOT_PENDING",
    });
  }
  if (row.requesterUserId.toString() === reviewerUserId) {
    throw new AppError(400, "You cannot approve your own access request", {
      code: "CANNOT_REVIEW_OWN_REQUEST",
    });
  }

  const now = new Date();
  row.status = "approved";
  row.reviewedByUserId = new mongoose.Types.ObjectId(reviewerUserId);
  row.reviewedAt = now;
  row.grantedAt = now;
  row.expiresAt = new Date(now.getTime() + row.durationMinutes * 60 * 1000);
  row.reviewNote = body.note?.trim() ?? "";
  await row.save();

  const lean = await AccessRequest.findById(row._id).lean();
  if (!lean) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  const [dto] = await hydrateDtos(organizationId, [lean]);

  await Membership.updateOne(
    {
      organizationId,
      userId: row.requesterUserId,
    },
    {
      $set: {
        accessRequestConsecutiveDenials: 0,
        accessRequestBlockedUntil: null,
      },
    },
  );

  await createNotificationsForUsers({
    organizationId,
    userIds: [row.requesterUserId.toString()],
    type: "access_request.approved",
    title: "Access approved",
    body: `Your request for “${dto!.secret.name}” was approved. Open to reveal it (re-auth required).`,
    href: `/app/secrets?reveal=${dto!.secret.id}`,
    meta: {
      requestId: dto!.id,
      secretId: dto!.secret.id,
      secretName: dto!.secret.name,
      status: "approved",
      action: "reveal",
    },
  });

  return dto!;
}

export async function denyAccessRequestForOrganization(
  organizationId: string,
  reviewerUserId: string,
  requestId: string,
  body: ReviewAccessRequestBody,
): Promise<AccessRequestDto> {
  if (!mongoose.isValidObjectId(requestId)) {
    throw new AppError(400, "Invalid request id", {
      code: "INVALID_ACCESS_REQUEST_ID",
    });
  }

  const row = await AccessRequest.findOne({
    _id: requestId,
    organizationId,
  });
  if (!row) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  if (row.status !== "pending") {
    throw new AppError(409, "Only pending requests can be denied", {
      code: "ACCESS_REQUEST_NOT_PENDING",
    });
  }
  if (row.requesterUserId.toString() === reviewerUserId) {
    throw new AppError(400, "You cannot deny your own access request", {
      code: "CANNOT_REVIEW_OWN_REQUEST",
    });
  }

  row.status = "denied";
  row.reviewedByUserId = new mongoose.Types.ObjectId(reviewerUserId);
  row.reviewedAt = new Date();
  row.reviewNote = body.note?.trim() ?? "";
  await row.save();

  const lean = await AccessRequest.findById(row._id).lean();
  if (!lean) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  const [dto] = await hydrateDtos(organizationId, [lean]);

  const membership = await Membership.findOne({
    organizationId,
    userId: row.requesterUserId,
  });
  let blockedUntil: Date | null = null;
  if (membership) {
    const nextDenials = (membership.accessRequestConsecutiveDenials ?? 0) + 1;
    membership.accessRequestConsecutiveDenials = nextDenials;
    if (nextDenials >= ACCESS_REQUEST_DENIAL_LIMIT) {
      blockedUntil = new Date(Date.now() + ACCESS_REQUEST_BLOCK_MS);
      membership.accessRequestBlockedUntil = blockedUntil;
      membership.accessRequestConsecutiveDenials = 0;
    }
    await membership.save();
  }

  const denyBody = blockedUntil
    ? `Your request for “${dto!.secret.name}” was rejected. After repeated denials, Reveal/Request is blocked until ${blockedUntil.toLocaleString()}.`
    : `Your request for “${dto!.secret.name}” was rejected. You can submit a new request from Secrets → Reveal.`;

  await createNotificationsForUsers({
    organizationId,
    userIds: [row.requesterUserId.toString()],
    type: "access_request.denied",
    title: blockedUntil ? "Access denied — temporarily blocked" : "Access denied",
    body: denyBody,
    href: `/app/secrets?request=${dto!.secret.id}`,
    meta: {
      requestId: dto!.id,
      secretId: dto!.secret.id,
      secretName: dto!.secret.name,
      status: "denied",
      action: "request",
      blockedUntil: blockedUntil?.toISOString() ?? null,
    },
  });

  return dto!;
}

export async function revokeAccessRequestForOrganization(
  organizationId: string,
  actorUserId: string,
  requestId: string,
): Promise<AccessRequestDto> {
  await expireStaleGrants(organizationId);

  if (!mongoose.isValidObjectId(requestId)) {
    throw new AppError(400, "Invalid request id", {
      code: "INVALID_ACCESS_REQUEST_ID",
    });
  }

  const row = await AccessRequest.findOne({
    _id: requestId,
    organizationId,
  });
  if (!row) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  if (row.status !== "approved") {
    throw new AppError(409, "Only active approved grants can be revoked", {
      code: "ACCESS_REQUEST_NOT_ACTIVE",
    });
  }

  row.status = "revoked";
  row.reviewedByUserId = new mongoose.Types.ObjectId(actorUserId);
  row.reviewedAt = new Date();
  await row.save();

  const lean = await AccessRequest.findById(row._id).lean();
  if (!lean) {
    throw new AppError(404, "Access request not found", {
      code: "ACCESS_REQUEST_NOT_FOUND",
    });
  }
  const [dto] = await hydrateDtos(organizationId, [lean]);

  await createNotificationsForUsers({
    organizationId,
    userIds: [row.requesterUserId.toString()],
    type: "access_request.revoked",
    title: "Access revoked",
    body: `Temporary access to “${dto!.secret.name}” was revoked.`,
    href: "/app/secrets",
    meta: {
      requestId: dto!.id,
      secretId: dto!.secret.id,
      secretName: dto!.secret.name,
      status: "revoked",
    },
  });

  return dto!;
}

/**
 * True when the user has a non-expired approved temporary grant for the secret.
 */
export async function hasActiveTemporarySecretAccess(
  organizationId: string,
  userId: string,
  secretId: string,
): Promise<boolean> {
  await expireStaleGrants(organizationId);
  const grant = await AccessRequest.findOne({
    organizationId,
    requesterUserId: userId,
    secretId,
    status: "approved",
    expiresAt: { $gt: new Date() },
  }).lean();
  return Boolean(grant);
}
