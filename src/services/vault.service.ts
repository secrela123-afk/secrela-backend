import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import { Membership } from "../models/Membership.model.js";
import { User } from "../models/User.model.js";
import {
  Vault,
  VAULT_COLORS,
  type VaultColor,
  type VaultRiskLevel,
} from "../models/Vault.model.js";
import {
  countSecretsByVault,
  countSecretsSummary,
} from "./secret.service.js";
import type {
  CreateVaultBody,
  UpdateVaultBody,
} from "../schemas/vault.schemas.js";
import { assertPlanCanCreateVault } from "./planEntitlement.service.js";

export type VaultMemberPreview = {
  id: string;
  name: string;
  initials: string;
};

export type VaultDto = {
  id: string;
  name: string;
  description: string;
  color: VaultColor;
  riskLevel: VaultRiskLevel;
  secretCount: number;
  memberCount: number;
  memberPreviews: VaultMemberPreview[];
  lastUpdatedAt: Date;
  lastUpdatedBy: { id: string; name: string } | null;
  createdAt: Date;
};

export type VaultsListResult = {
  vaults: VaultDto[];
  summary: {
    totalVaults: number;
    totalSecrets: number;
    totalMembers: number;
    highRiskSecrets: number;
    expiringSoon: number;
    vaultsCreatedThisMonth: number;
  };
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

async function orgMemberAccessPreview(organizationId: string): Promise<{
  memberCount: number;
  memberPreviews: VaultMemberPreview[];
}> {
  const rows = await Membership.find({ organizationId })
    .sort({ createdAt: 1 })
    .limit(12)
    .lean();
  const users = await User.find({
    _id: { $in: rows.map((r) => r.userId) },
  })
    .select("name")
    .lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const previews: VaultMemberPreview[] = [];
  for (const row of rows) {
    const user = byId.get(row.userId.toString());
    if (!user) continue;
    previews.push({
      id: user._id.toString(),
      name: user.name,
      initials: initials(user.name) || "?",
    });
    if (previews.length >= 3) break;
  }
  const memberCount = await Membership.countDocuments({ organizationId });
  return { memberCount, memberPreviews: previews };
}

async function toVaultDto(
  vault: {
    _id: { toString(): string };
    name: string;
    description?: string | null;
    color?: string | null;
    riskLevel?: string | null;
    updatedAt: Date;
    createdAt: Date;
    updatedByUserId?: { toString(): string } | null;
  },
  access: { memberCount: number; memberPreviews: VaultMemberPreview[] },
  secretCount = 0,
): Promise<VaultDto> {
  let lastUpdatedBy: { id: string; name: string } | null = null;
  if (vault.updatedByUserId) {
    const user = await User.findById(vault.updatedByUserId).select("name").lean();
    if (user) {
      lastUpdatedBy = { id: user._id.toString(), name: user.name };
    }
  }

  return {
    id: vault._id.toString(),
    name: vault.name,
    description: vault.description ?? "",
    color: (vault.color as VaultColor) ?? "brand",
    riskLevel: (vault.riskLevel as VaultRiskLevel) ?? "unknown",
    secretCount,
    memberCount: access.memberCount,
    memberPreviews: access.memberPreviews,
    lastUpdatedAt: vault.updatedAt,
    lastUpdatedBy,
    createdAt: vault.createdAt,
  };
}

export async function listVaultsForOrganization(
  organizationId: string,
): Promise<VaultsListResult> {
  const access = await orgMemberAccessPreview(organizationId);
  const vaults = await Vault.find({ organizationId })
    .sort({ updatedAt: -1 })
    .lean();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const vaultsCreatedThisMonth = vaults.filter(
    (v) => new Date(v.createdAt).getTime() >= monthStart.getTime(),
  ).length;

  const [countsByVault, secretsSummary] = await Promise.all([
    countSecretsByVault(organizationId),
    countSecretsSummary(organizationId),
  ]);

  const dtos: VaultDto[] = [];
  for (const v of vaults) {
    dtos.push(
      await toVaultDto(
        v,
        access,
        countsByVault.get(v._id.toString()) ?? 0,
      ),
    );
  }

  return {
    vaults: dtos,
    summary: {
      totalVaults: dtos.length,
      totalSecrets: secretsSummary.totalSecrets,
      totalMembers: access.memberCount,
      highRiskSecrets: secretsSummary.highRiskSecrets,
      expiringSoon: secretsSummary.expiringSoon,
      vaultsCreatedThisMonth,
    },
  };
}

export async function getVaultForOrganization(
  organizationId: string,
  vaultId: string,
): Promise<VaultDto> {
  if (!mongoose.isValidObjectId(vaultId)) {
    throw new AppError(400, "Invalid vault id", { code: "INVALID_VAULT_ID" });
  }
  const vault = await Vault.findOne({ _id: vaultId, organizationId });
  if (!vault) {
    throw new AppError(404, "Vault not found", { code: "VAULT_NOT_FOUND" });
  }
  const access = await orgMemberAccessPreview(organizationId);
  const counts = await countSecretsByVault(organizationId);
  return toVaultDto(
    vault,
    access,
    counts.get(vault._id.toString()) ?? 0,
  );
}

/** Cycle icon colors in order so each new vault gets the next accent. */
async function nextVaultColor(organizationId: string): Promise<VaultColor> {
  const count = await Vault.countDocuments({ organizationId });
  return VAULT_COLORS[count % VAULT_COLORS.length]!;
}

export async function createVaultForOrganization(
  organizationId: string,
  actorUserId: string,
  body: CreateVaultBody,
): Promise<VaultDto> {
  await assertPlanCanCreateVault(organizationId);
  try {
    const color = await nextVaultColor(organizationId);
    const vault = await Vault.create({
      organizationId,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      color,
      riskLevel: body.riskLevel ?? "unknown",
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    });
    const access = await orgMemberAccessPreview(organizationId);
    return toVaultDto(vault, access, 0);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(409, "A vault with this name already exists", {
        code: "VAULT_NAME_TAKEN",
      });
    }
    throw err;
  }
}

export async function updateVaultForOrganization(
  organizationId: string,
  actorUserId: string,
  vaultId: string,
  body: UpdateVaultBody,
): Promise<VaultDto> {
  if (!mongoose.isValidObjectId(vaultId)) {
    throw new AppError(400, "Invalid vault id", { code: "INVALID_VAULT_ID" });
  }

  const vault = await Vault.findOne({ _id: vaultId, organizationId });
  if (!vault) {
    throw new AppError(404, "Vault not found", { code: "VAULT_NOT_FOUND" });
  }

  if (body.name !== undefined) vault.name = body.name.trim();
  if (body.description !== undefined) {
    vault.description = body.description.trim();
  }
  // Color stays server-assigned; edits only change risk / metadata.
  if (body.riskLevel !== undefined) vault.riskLevel = body.riskLevel;
  vault.updatedByUserId = new mongoose.Types.ObjectId(actorUserId);

  try {
    await vault.save();
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(409, "A vault with this name already exists", {
        code: "VAULT_NAME_TAKEN",
      });
    }
    throw err;
  }

  const access = await orgMemberAccessPreview(organizationId);
  const counts = await countSecretsByVault(organizationId);
  return toVaultDto(
    vault,
    access,
    counts.get(vault._id.toString()) ?? 0,
  );
}

export async function deleteVaultForOrganization(
  organizationId: string,
  vaultId: string,
): Promise<{ deletedVaultId: string; name: string }> {
  if (!mongoose.isValidObjectId(vaultId)) {
    throw new AppError(400, "Invalid vault id", { code: "INVALID_VAULT_ID" });
  }

  const vault = await Vault.findOne({ _id: vaultId, organizationId });
  if (!vault) {
    throw new AppError(404, "Vault not found", { code: "VAULT_NOT_FOUND" });
  }

  const counts = await countSecretsByVault(organizationId);
  const secretCount = counts.get(vault._id.toString()) ?? 0;
  if (secretCount > 0) {
    throw new AppError(
      409,
      "Delete or move secrets in this vault before deleting it",
      { code: "VAULT_NOT_EMPTY" },
    );
  }

  await Vault.deleteOne({ _id: vault._id });
  return { deletedVaultId: vaultId, name: vault.name };
}

