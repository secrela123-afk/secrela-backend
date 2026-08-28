import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import {
  clampPermissionsToActor,
  ensureCustomRoleBaselinePermissions,
  PERMISSIONS,
  permissionsInclude,
  sanitizeCustomRolePermissions,
  SYSTEM_ROLE_PERMISSIONS,
  type Permission,
} from "../lib/permissions.js";
import { slugifyOrganizationName } from "../lib/slugify.js";
import { Membership } from "../models/Membership.model.js";
import {
  Role,
  SYSTEM_ROLE_KEYS,
  type RoleDocument,
  type SystemRoleKey,
} from "../models/Role.model.js";
import { assertPlanFeature } from "./planEntitlement.service.js";

export type RoleDto = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  permissions: Permission[];
  kind: "system" | "custom";
  systemKey: SystemRoleKey | null;
  isActive: boolean;
  memberCount: number;
  createdAt: Date;
};

export type ResolvedOrgRole = {
  roleId: string;
  name: string;
  systemKey: SystemRoleKey | null;
  permissions: Permission[];
  kind: "system" | "custom";
};

const SYSTEM_BLURBS: Record<SystemRoleKey, string> = {
  owner: "Full system access including organization settings.",
  admin:
    "Full matrix permissions — manage members, roles, vaults, secrets, and organization settings.",
};

function toRoleDto(
  role: RoleDocument | (RoleDocument & { toObject?: () => unknown }),
  memberCount = 0,
): RoleDto {
  const doc = "toObject" in role && typeof role.toObject === "function"
    ? (role as { toObject: () => RoleDocument }).toObject()
    : role;
  const rawKey = doc.systemKey as string | null | undefined;
  const systemKey =
    rawKey === "owner" || rawKey === "admin" ? rawKey : null;
  return {
    id: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    permissions: [...(doc.permissions as Permission[])],
    kind: (systemKey ? "system" : doc.kind) as "system" | "custom",
    systemKey,
    isActive: doc.isActive !== false,
    memberCount,
    createdAt: doc.createdAt,
  };
}

async function memberCountsByRoleId(
  organizationId: string,
): Promise<Map<string, number>> {
  const rows = await Membership.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>(
    [
      {
        $match: {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          roleId: { $ne: null },
        },
      },
      { $group: { _id: "$roleId", n: { $sum: 1 } } },
    ],
  );
  return new Map(rows.map((r) => [r._id.toString(), r.n]));
}

/**
 * Ensures Owner + Admin system roles (full permissions).
 * Legacy system Member roles become custom. No new Member is seeded.
 */
export async function ensureOrganizationRoles(
  organizationId: string,
): Promise<Record<SystemRoleKey, RoleDocument>> {
  const orgObjectId = new mongoose.Types.ObjectId(organizationId);
  const result = {} as Record<SystemRoleKey, RoleDocument>;

  for (const key of SYSTEM_ROLE_KEYS) {
    let role = await Role.findOne({ organizationId: orgObjectId, systemKey: key });
    if (!role) {
      role = await Role.create({
        organizationId: orgObjectId,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        slug: key,
        description: SYSTEM_BLURBS[key],
        permissions: [...SYSTEM_ROLE_PERMISSIONS[key]],
        kind: "system",
        systemKey: key,
        isActive: true,
      });
    } else {
      role.permissions = [...SYSTEM_ROLE_PERMISSIONS[key]] as Permission[];
      role.description = SYSTEM_BLURBS[key];
      role.kind = "system";
      await role.save();
    }
    result[key] = role;
  }

  const legacyMemberRoles = await Role.find({
    organizationId: orgObjectId,
    systemKey: "member",
  });
  for (const legacy of legacyMemberRoles) {
    legacy.kind = "custom";
    legacy.systemKey = null;
    if (!legacy.description) {
      legacy.description =
        "Legacy Member role (converted to custom — edit or delete as needed).";
    }
    await legacy.save();
  }

  // Custom roles must always include org.read (workspace bootstrap).
  const customRoles = await Role.find({
    organizationId: orgObjectId,
    kind: "custom",
  });
  for (const custom of customRoles) {
    const next = ensureCustomRoleBaselinePermissions(
      (custom.permissions as Permission[]) ?? [],
    );
    const prev = custom.permissions as string[];
    if (
      next.length !== prev.length ||
      next.some((p, i) => p !== prev[i])
    ) {
      custom.permissions = next;
      await custom.save();
    }
  }

  const legacyMemberships = await Membership.find({
    organizationId: orgObjectId,
    $or: [{ roleId: null }, { roleId: { $exists: false } }],
  });

  for (const row of legacyMemberships) {
    const key = row.role as string | undefined;
    if (key === "owner") {
      row.roleId = result.owner._id;
    } else if (key === "admin") {
      row.roleId = result.admin._id;
    } else {
      const converted = await Role.findOne({
        organizationId: orgObjectId,
        slug: "member",
        kind: "custom",
      });
      row.roleId = converted?._id ?? result.admin._id;
    }
    await row.save();
  }

  return result;
}

export async function resolveRoleForMembership(membership: {
  _id?: { toString(): string };
  organizationId: { toString(): string } | string;
  roleId?: { toString(): string } | null;
  role?: string | null;
}): Promise<ResolvedOrgRole> {
  const organizationId = membership.organizationId.toString();
  const system = await ensureOrganizationRoles(organizationId);

  let roleDoc: RoleDocument | null = null;
  if (membership.roleId) {
    const found = await Role.findById(membership.roleId.toString());
    if (found && found.organizationId.toString() === organizationId) {
      roleDoc = found;
    }
  }

  if (!roleDoc) {
    const key = membership.role as string | undefined;
    if (key === "owner") roleDoc = system.owner;
    else if (key === "admin") roleDoc = system.admin;
    else {
      const converted = await Role.findOne({
        organizationId,
        slug: "member",
        kind: "custom",
      });
      roleDoc = converted ?? system.admin;
    }
    if (membership._id) {
      await Membership.findByIdAndUpdate(membership._id.toString(), {
        $set: { roleId: roleDoc._id },
      });
    }
  }

  const rawKey = roleDoc.systemKey as string | null | undefined;
  const systemKey =
    rawKey === "owner" || rawKey === "admin" ? rawKey : null;

  let permissions = [...(roleDoc.permissions as Permission[])];
  if (!systemKey) {
    const withBaseline = ensureCustomRoleBaselinePermissions(permissions);
    if (
      withBaseline.length !== permissions.length ||
      withBaseline.some((p, i) => p !== permissions[i])
    ) {
      await Role.updateOne(
        { _id: roleDoc._id },
        { $set: { permissions: withBaseline } },
      );
      permissions = withBaseline;
    }
  }

  return {
    roleId: roleDoc._id.toString(),
    name: roleDoc.name,
    systemKey,
    permissions,
    kind: (systemKey ? "system" : "custom") as "system" | "custom",
  };
}

export async function getSystemRoleId(
  organizationId: string,
  key: SystemRoleKey,
): Promise<string> {
  const system = await ensureOrganizationRoles(organizationId);
  return system[key]._id.toString();
}

export async function listRolesForOrganization(
  organizationId: string,
): Promise<{ roles: RoleDto[]; permissionCatalog: Permission[] }> {
  await ensureOrganizationRoles(organizationId);
  const roles = await Role.find({ organizationId, isActive: true })
    .sort({ kind: -1, createdAt: 1 })
    .lean();
  const counts = await memberCountsByRoleId(organizationId);

  return {
    roles: roles.map((r) =>
      toRoleDto(r as RoleDocument, counts.get(r._id.toString()) ?? 0),
    ),
    permissionCatalog: [...PERMISSIONS],
  };
}

export async function createCustomRole(input: {
  organizationId: string;
  actorPermissions: readonly string[];
  name: string;
  description?: string | null;
  permissions: readonly string[];
}): Promise<RoleDto> {
  if (!permissionsInclude(input.actorPermissions, "role.manage")) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission: "role.manage" },
    });
  }

  const name = input.name.trim();
  if (name.length < 2) {
    throw new AppError(400, "Role name is too short", {
      code: "INVALID_ROLE_NAME",
    });
  }

  await ensureOrganizationRoles(input.organizationId);

  let permissions = sanitizeCustomRolePermissions(input.permissions);
  permissions = clampPermissionsToActor(permissions, input.actorPermissions);
  permissions = ensureCustomRoleBaselinePermissions(permissions);

  if (permissions.length === 0) {
    throw new AppError(400, "Select at least one permission", {
      code: "ROLE_PERMISSIONS_REQUIRED",
    });
  }

  await assertPlanFeature(input.organizationId, "customRoles");

  const baseSlug = slugifyOrganizationName(name) || "role";
  let slug = baseSlug;
  let attempt = 0;
  while (attempt < 20) {
    const exists = await Role.exists({
      organizationId: input.organizationId,
      slug,
    });
    if (!exists) break;
    attempt += 1;
    slug = `${baseSlug}-${attempt + 1}`;
  }

  try {
    const role = await Role.create({
      organizationId: input.organizationId,
      name,
      slug,
      description: input.description?.trim() || null,
      permissions,
      kind: "custom",
      systemKey: null,
      isActive: true,
    });
    return toRoleDto(role, 0);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(409, "A role with this name already exists", {
        code: "ROLE_NAME_TAKEN",
      });
    }
    throw err;
  }
}

export async function updateCustomRole(input: {
  organizationId: string;
  roleId: string;
  actorPermissions: readonly string[];
  name?: string;
  description?: string | null;
  permissions?: readonly string[];
}): Promise<RoleDto> {
  if (!permissionsInclude(input.actorPermissions, "role.manage")) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission: "role.manage" },
    });
  }

  if (!mongoose.isValidObjectId(input.roleId)) {
    throw new AppError(400, "Invalid role id", { code: "INVALID_ROLE_ID" });
  }

  const role = await Role.findOne({
    _id: input.roleId,
    organizationId: input.organizationId,
  });
  if (!role) {
    throw new AppError(404, "Role not found", { code: "ROLE_NOT_FOUND" });
  }

  if (role.kind === "system") {
    // System roles: allow description polish only — permissions stay seeded.
    if (input.description !== undefined) {
      role.description = input.description?.trim() || null;
      await role.save();
    }
    if (input.name !== undefined || input.permissions !== undefined) {
      throw new AppError(403, "System role permissions cannot be changed", {
        code: "SYSTEM_ROLE_LOCKED",
      });
    }
    const counts = await memberCountsByRoleId(input.organizationId);
    return toRoleDto(role, counts.get(role._id.toString()) ?? 0);
  }

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) {
      throw new AppError(400, "Role name is too short", {
        code: "INVALID_ROLE_NAME",
      });
    }
    role.name = name;
  }
  if (input.description !== undefined) {
    role.description = input.description?.trim() || null;
  }
  if (input.permissions !== undefined) {
    let permissions = sanitizeCustomRolePermissions(input.permissions);
    permissions = clampPermissionsToActor(
      permissions,
      input.actorPermissions,
    );
    permissions = ensureCustomRoleBaselinePermissions(permissions);
    if (permissions.length === 0) {
      throw new AppError(400, "Select at least one permission", {
        code: "ROLE_PERMISSIONS_REQUIRED",
      });
    }
    role.permissions = permissions;
  }

  await role.save();
  const counts = await memberCountsByRoleId(input.organizationId);
  return toRoleDto(role, counts.get(role._id.toString()) ?? 0);
}

export async function deleteCustomRole(input: {
  organizationId: string;
  roleId: string;
  actorPermissions: readonly string[];
}): Promise<{ deletedRoleId: string }> {
  if (!permissionsInclude(input.actorPermissions, "role.manage")) {
    throw new AppError(403, "You do not have permission for this action", {
      code: "FORBIDDEN",
      details: { permission: "role.manage" },
    });
  }

  if (!mongoose.isValidObjectId(input.roleId)) {
    throw new AppError(400, "Invalid role id", { code: "INVALID_ROLE_ID" });
  }

  const role = await Role.findOne({
    _id: input.roleId,
    organizationId: input.organizationId,
  });
  if (!role) {
    throw new AppError(404, "Role not found", { code: "ROLE_NOT_FOUND" });
  }
  if (role.kind === "system") {
    throw new AppError(403, "System roles cannot be deleted", {
      code: "SYSTEM_ROLE_LOCKED",
    });
  }

  const inUse = await Membership.countDocuments({
    organizationId: input.organizationId,
    roleId: role._id,
  });
  if (inUse > 0) {
    throw new AppError(
      409,
      "Move or remove members from this role before deleting it",
      { code: "ROLE_IN_USE", details: { memberCount: inUse } },
    );
  }

  await Role.deleteOne({ _id: role._id });
  return { deletedRoleId: input.roleId };
}

export async function assertAssignableRole(input: {
  organizationId: string;
  roleId: string;
  /** When true, owner system role is rejected (invites / demotions). */
  disallowOwner?: boolean;
}): Promise<RoleDocument> {
  await ensureOrganizationRoles(input.organizationId);
  if (!mongoose.isValidObjectId(input.roleId)) {
    throw new AppError(400, "Invalid role id", { code: "INVALID_ROLE_ID" });
  }
  const role = await Role.findOne({
    _id: input.roleId,
    organizationId: input.organizationId,
    isActive: true,
  });
  if (!role) {
    throw new AppError(404, "Role not found", { code: "ROLE_NOT_FOUND" });
  }
  if (input.disallowOwner && role.systemKey === "owner") {
    throw new AppError(403, "The owner role cannot be assigned this way", {
      code: "CANNOT_ASSIGN_OWNER",
    });
  }
  return role;
}
