import type { SystemRoleKey } from "../models/Role.model.js";

/**
 * Fine-grained permissions for organization-scoped actions.
 * Custom roles store a subset of this catalog on the Role document.
 * Backend checks are the security boundary — frontend is UX only.
 */
export const PERMISSIONS = [
  "org.read",
  "org.update",
  "member.read",
  "member.invite",
  "member.remove",
  "member.disable",
  "member.role.update",
  "role.read",
  "role.manage",
  "vault.read",
  "vault.create",
  "vault.update",
  "vault.delete",
  "secret.read",
  "secret.create",
  "secret.update",
  "secret.delete",
  "secret.reveal",
  "access_request.create",
  "access_request.review",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Seed templates for system roles (Owner + Admin only).
 * Admin has the full matrix — same operational power as Owner for permissions.
 * Difference is structural: only one Owner membership; Admin cannot remove/change Owner.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<
  SystemRoleKey,
  readonly Permission[]
> = {
  owner: [...PERMISSIONS],
  admin: [...PERMISSIONS],
};

/** @deprecated Legacy member seed — used only when converting old orgs. */
export const LEGACY_MEMBER_PERMISSIONS: readonly Permission[] = [
  "org.read",
  "member.read",
  "role.read",
  "vault.read",
  "secret.read",
  "access_request.create",
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsInclude(
  granted: readonly string[],
  permission: Permission,
): boolean {
  return granted.includes(permission);
}

/** Strip invalid permission strings from a custom-role payload. */
export function sanitizeCustomRolePermissions(
  input: readonly string[],
): Permission[] {
  const unique = new Set<Permission>();
  for (const raw of input) {
    if (!isPermission(raw)) continue;
    unique.add(raw);
  }
  return [...unique];
}

/**
 * Every custom role must include:
 * - org.read — load workspace
 * - access_request.create — request temporary secret access (Reveal flow)
 */
export const CUSTOM_ROLE_REQUIRED_PERMISSIONS = [
  "org.read",
  "access_request.create",
] as const;

export function ensureCustomRoleBaselinePermissions(
  permissions: readonly Permission[],
): Permission[] {
  const set = new Set<Permission>(permissions);
  for (const required of CUSTOM_ROLE_REQUIRED_PERMISSIONS) {
    set.add(required);
  }
  // Keep catalog order for stable UI / diffs.
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Actor may only grant permissions they themselves hold. */
export function clampPermissionsToActor(
  requested: readonly Permission[],
  actorPermissions: readonly string[],
): Permission[] {
  return requested.filter((p) => actorPermissions.includes(p));
}
