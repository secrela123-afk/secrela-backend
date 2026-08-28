import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import {
  decryptSecretValue,
  encryptSecretValue,
  generateWrappedDek,
  unwrapDek,
  type EncryptedBlob,
} from "../lib/secretsCrypto.js";
import { Organization } from "../models/Organization.model.js";
import {
  Secret,
  type SecretRiskLevel,
  type SecretType,
} from "../models/Secret.model.js";
import { User } from "../models/User.model.js";
import { Vault } from "../models/Vault.model.js";
import type {
  CreateSecretBody,
  UpdateSecretBody,
} from "../schemas/secret.schemas.js";
import { assertPlanCanCreateSecret } from "./planEntitlement.service.js";

export type SecretOwnerPreview = {
  id: string;
  name: string;
  initials: string;
};

export type SecretVaultRef = {
  id: string;
  name: string;
  color: string;
};

export type SecretDto = {
  id: string;
  name: string;
  description: string;
  type: SecretType;
  riskLevel: SecretRiskLevel;
  status: "active" | "expired";
  vault: SecretVaultRef;
  owner: SecretOwnerPreview;
  lastUpdatedAt: Date;
  lastAccessedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** Permanent reveal OR active temporary grant for the current viewer. */
  canReveal: boolean;
  temporaryAccessExpiresAt: Date | null;
  /** Viewer already has a pending request for this secret — wait for review. */
  hasPendingAccessRequest: boolean;
};

export type SecretActivityItem = {
  id: string;
  secretId: string;
  secretName: string;
  action: "accessed" | "updated" | "created";
  actorName: string;
  at: Date;
};

export type SecretsListResult = {
  secrets: SecretDto[];
  summary: {
    totalSecrets: number;
    activeSecrets: number;
    highRiskSecrets: number;
    expiredSecrets: number;
  };
  byRisk: Record<SecretRiskLevel, number>;
  byType: Record<SecretType, number>;
  recentActivity: SecretActivityItem[];
  /** Present for non-Owner/Admin viewers — request/reveal-via-request cooldown. */
  viewerAccessBlock: {
    blocked: boolean;
    blockedUntil: string | null;
    consecutiveDenials: number;
  } | null;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function computeStatus(expiresAt: Date | null | undefined): "active" | "expired" {
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    return "expired";
  }
  return "active";
}

async function ensureOrgDek(organizationId: string): Promise<Buffer> {
  const org = await Organization.findById(organizationId);
  if (!org) {
    throw new AppError(404, "Organization not found", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  if (!org.dekWrapped) {
    org.dekWrapped = generateWrappedDek(organizationId) as EncryptedBlob &
      typeof org.dekWrapped;
    await org.save();
  }

  return unwrapDek(org.dekWrapped, organizationId);
}

async function assertVaultInOrg(
  organizationId: string,
  vaultId: string,
): Promise<InstanceType<typeof Vault>> {
  if (!mongoose.isValidObjectId(vaultId)) {
    throw new AppError(400, "Invalid vault id", { code: "INVALID_VAULT_ID" });
  }
  const vault = await Vault.findOne({ _id: vaultId, organizationId });
  if (!vault) {
    throw new AppError(404, "Vault not found", { code: "VAULT_NOT_FOUND" });
  }
  return vault;
}

async function toSecretDto(
  secret: {
    _id: { toString(): string };
    name: string;
    description?: string | null;
    type: string;
    riskLevel?: string | null;
    vaultId: { toString(): string };
    ownerUserId: { toString(): string };
    updatedAt: Date;
    createdAt: Date;
    lastAccessedAt?: Date | null;
    expiresAt?: Date | null;
  },
  vaultById: Map<string, { name: string; color: string }>,
  userById: Map<string, { name: string }>,
  access: {
    canReveal: boolean;
    temporaryAccessExpiresAt: Date | null;
    hasPendingAccessRequest: boolean;
  },
): Promise<SecretDto> {
  const vaultId = secret.vaultId.toString();
  const ownerId = secret.ownerUserId.toString();
  const vault = vaultById.get(vaultId);
  const owner = userById.get(ownerId);
  const ownerName = owner?.name ?? "Unknown";

  return {
    id: secret._id.toString(),
    name: secret.name,
    description: secret.description ?? "",
    type: secret.type as SecretType,
    riskLevel: (secret.riskLevel as SecretRiskLevel) ?? "unknown",
    status: computeStatus(secret.expiresAt ?? null),
    vault: {
      id: vaultId,
      name: vault?.name ?? "Unknown vault",
      color: vault?.color ?? "brand",
    },
    owner: {
      id: ownerId,
      name: ownerName,
      initials: initials(ownerName) || "?",
    },
    lastUpdatedAt: secret.updatedAt,
    lastAccessedAt: secret.lastAccessedAt ?? null,
    expiresAt: secret.expiresAt ?? null,
    createdAt: secret.createdAt,
    canReveal: access.canReveal,
    temporaryAccessExpiresAt: access.temporaryAccessExpiresAt,
    hasPendingAccessRequest: access.hasPendingAccessRequest,
  };
}

export async function listSecretsForOrganization(
  organizationId: string,
  viewer: { userId: string; permissions: readonly string[] },
): Promise<SecretsListResult> {
  const secrets = await Secret.find({ organizationId })
    .sort({ updatedAt: -1 })
    .lean();

  const vaultIds = [...new Set(secrets.map((s) => s.vaultId.toString()))];
  const ownerIds = [...new Set(secrets.map((s) => s.ownerUserId.toString()))];

  const { expireStaleGrants, getAccessRequestBlockStatus } = await import(
    "./accessRequest.service.js"
  );
  const { AccessRequest } = await import("../models/AccessRequest.model.js");
  await expireStaleGrants(organizationId);

  const permanentReveal = viewer.permissions.includes("secret.reveal");
  const blockStatus = permanentReveal
    ? null
    : await getAccessRequestBlockStatus(organizationId, viewer.userId);
  const grants = permanentReveal
    ? []
    : await AccessRequest.find({
        organizationId,
        requesterUserId: viewer.userId,
        status: "approved",
        expiresAt: { $gt: new Date() },
      })
        .select("secretId expiresAt")
        .lean();
  const grantBySecret = new Map(
    grants.map((g) => [g.secretId.toString(), g.expiresAt as Date]),
  );

  const pendingRows = permanentReveal
    ? []
    : await AccessRequest.find({
        organizationId,
        requesterUserId: viewer.userId,
        status: "pending",
      })
        .select("secretId")
        .lean();
  const pendingSecretIds = new Set(
    pendingRows.map((p) => p.secretId.toString()),
  );

  const [vaults, users] = await Promise.all([
    Vault.find({ _id: { $in: vaultIds }, organizationId })
      .select("name color")
      .lean(),
    User.find({ _id: { $in: ownerIds } }).select("name").lean(),
  ]);

  const vaultById = new Map(
    vaults.map((v) => [v._id.toString(), { name: v.name, color: v.color }]),
  );
  const userById = new Map(
    users.map((u) => [u._id.toString(), { name: u.name }]),
  );

  const dtos: SecretDto[] = [];
  for (const s of secrets) {
    const id = s._id.toString();
    const tempExp = grantBySecret.get(id) ?? null;
    dtos.push(
      await toSecretDto(s, vaultById, userById, {
        canReveal: permanentReveal || Boolean(tempExp),
        temporaryAccessExpiresAt: tempExp,
        hasPendingAccessRequest: pendingSecretIds.has(id),
      }),
    );
  }

  const byRisk: Record<SecretRiskLevel, number> = {
    unknown: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  const byType: Record<SecretType, number> = {
    credential: 0,
    api_key: 0,
    database: 0,
    token: 0,
    key_pair: 0,
    other: 0,
  };

  let activeSecrets = 0;
  let expiredSecrets = 0;
  for (const dto of dtos) {
    byRisk[dto.riskLevel] += 1;
    byType[dto.type] += 1;
    if (dto.status === "expired") expiredSecrets += 1;
    else activeSecrets += 1;
  }

  const recentActivity: SecretActivityItem[] = dtos
    .flatMap((dto) => {
      const items: SecretActivityItem[] = [];
      if (dto.lastAccessedAt) {
        items.push({
          id: `${dto.id}:accessed`,
          secretId: dto.id,
          secretName: dto.name,
          action: "accessed",
          actorName: dto.owner.name,
          at: dto.lastAccessedAt,
        });
      }
      items.push({
        id: `${dto.id}:updated`,
        secretId: dto.id,
        secretName: dto.name,
        action: "updated",
        actorName: dto.owner.name,
        at: dto.lastUpdatedAt,
      });
      return items;
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8);

  return {
    secrets: dtos,
    summary: {
      totalSecrets: dtos.length,
      activeSecrets,
      highRiskSecrets: byRisk.high,
      expiredSecrets,
    },
    byRisk,
    byType,
    recentActivity,
    viewerAccessBlock: blockStatus
      ? {
          blocked: blockStatus.blocked,
          blockedUntil: blockStatus.blockedUntil
            ? blockStatus.blockedUntil.toISOString()
            : null,
          consecutiveDenials: blockStatus.consecutiveDenials,
        }
      : null,
  };
}

export async function createSecretForOrganization(
  organizationId: string,
  actorUserId: string,
  body: CreateSecretBody,
  actorPermissions: readonly string[] = [],
): Promise<SecretDto> {
  await assertPlanCanCreateSecret(organizationId);
  const vault = await assertVaultInOrg(organizationId, body.vaultId);
  const dek = await ensureOrgDek(organizationId);

  const expiresAt =
    body.expiresAt === undefined || body.expiresAt === null
      ? null
      : new Date(body.expiresAt);

  let secret;
  try {
    const secretId = new mongoose.Types.ObjectId();
    const valueEnc = encryptSecretValue(dek, body.value, secretId.toString());
    (body as { value?: string }).value = undefined;

    secret = await Secret.create({
      _id: secretId,
      organizationId,
      vaultId: vault._id,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      type: body.type,
      riskLevel: body.riskLevel ?? "unknown",
      valueEnc,
      ownerUserId: actorUserId,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      expiresAt,
      lastAccessedAt: null,
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(
        409,
        "A secret with this name already exists in the vault",
        { code: "SECRET_NAME_TAKEN" },
      );
    }
    throw err;
  }

  const list = await listSecretsForOrganization(organizationId, {
    userId: actorUserId,
    permissions: actorPermissions,
  });
  const dto = list.secrets.find((s) => s.id === secret._id.toString());
  if (!dto) {
    throw new AppError(500, "Secret created but could not be loaded", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return dto;
}

export async function updateSecretForOrganization(
  organizationId: string,
  actorUserId: string,
  secretId: string,
  body: UpdateSecretBody,
  actorPermissions: readonly string[] = [],
): Promise<SecretDto> {
  if (!mongoose.isValidObjectId(secretId)) {
    throw new AppError(400, "Invalid secret id", { code: "INVALID_SECRET_ID" });
  }

  const secret = await Secret.findOne({ _id: secretId, organizationId });
  if (!secret) {
    throw new AppError(404, "Secret not found", { code: "SECRET_NOT_FOUND" });
  }

  if (body.vaultId !== undefined) {
    const vault = await assertVaultInOrg(organizationId, body.vaultId);
    secret.vaultId = vault._id;
  }
  if (body.name !== undefined) secret.name = body.name.trim();
  if (body.description !== undefined) {
    secret.description = body.description.trim();
  }
  if (body.type !== undefined) secret.type = body.type;
  if (body.riskLevel !== undefined) secret.riskLevel = body.riskLevel;
  if (body.expiresAt !== undefined) {
    secret.expiresAt =
      body.expiresAt === null ? null : new Date(body.expiresAt);
  }

  if (body.value !== undefined) {
    const dek = await ensureOrgDek(organizationId);
    secret.valueEnc = encryptSecretValue(
      dek,
      body.value,
      secret._id.toString(),
    ) as typeof secret.valueEnc;
    (body as { value?: string }).value = undefined;
  }

  secret.updatedByUserId = new mongoose.Types.ObjectId(actorUserId);

  try {
    await secret.save();
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(
        409,
        "A secret with this name already exists in the vault",
        { code: "SECRET_NAME_TAKEN" },
      );
    }
    throw err;
  }

  const list = await listSecretsForOrganization(organizationId, {
    userId: actorUserId,
    permissions: actorPermissions,
  });
  const dto = list.secrets.find((s) => s.id === secretId);
  if (!dto) {
    throw new AppError(404, "Secret not found", { code: "SECRET_NOT_FOUND" });
  }
  return dto;
}

export async function deleteSecretForOrganization(
  organizationId: string,
  secretId: string,
): Promise<{ deletedSecretId: string; name: string }> {
  if (!mongoose.isValidObjectId(secretId)) {
    throw new AppError(400, "Invalid secret id", { code: "INVALID_SECRET_ID" });
  }

  const secret = await Secret.findOne({ _id: secretId, organizationId });
  if (!secret) {
    throw new AppError(404, "Secret not found", { code: "SECRET_NOT_FOUND" });
  }

  const name = secret.name;
  await Secret.deleteOne({ _id: secret._id });
  return { deletedSecretId: secretId, name };
}

/**
 * Decrypt for reveal only. Caller must enforce HIGH step-up + secret.reveal.
 * Never log the returned value.
 */
export async function revealSecretForOrganization(
  organizationId: string,
  secretId: string,
  actorUserId: string,
): Promise<{ secretId: string; value: string; name: string }> {
  if (!mongoose.isValidObjectId(secretId)) {
    throw new AppError(400, "Invalid secret id", { code: "INVALID_SECRET_ID" });
  }

  const secret = await Secret.findOne({ _id: secretId, organizationId });
  if (!secret) {
    throw new AppError(404, "Secret not found", { code: "SECRET_NOT_FOUND" });
  }

  const dek = await ensureOrgDek(organizationId);
  const value = decryptSecretValue(
    dek,
    secret.valueEnc,
    secret._id.toString(),
  );

  secret.lastAccessedAt = new Date();
  secret.updatedByUserId = new mongoose.Types.ObjectId(actorUserId);
  // Do not bump updatedAt for access-only — use markModified carefully.
  // Mongoose timestamps will bump updatedAt on save; acceptable for MVP.
  await secret.save();

  return { secretId, value, name: secret.name };
}

/** Aggregate helpers for vault summary cards. */
export async function countSecretsByVault(
  organizationId: string,
): Promise<Map<string, number>> {
  const rows = await Secret.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
    { $group: { _id: "$vaultId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

export async function countSecretsSummary(organizationId: string): Promise<{
  totalSecrets: number;
  highRiskSecrets: number;
  expiringSoon: number;
}> {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const [totalSecrets, highRiskSecrets, expiringSoon] = await Promise.all([
    Secret.countDocuments({ organizationId }),
    Secret.countDocuments({ organizationId, riskLevel: "high" }),
    Secret.countDocuments({
      organizationId,
      expiresAt: { $gte: now, $lte: in30 },
    }),
  ]);
  return { totalSecrets, highRiskSecrets, expiringSoon };
}
