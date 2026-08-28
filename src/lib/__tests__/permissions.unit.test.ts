import { describe, expect, it } from "vitest";
import {
  clampPermissionsToActor,
  isPermission,
  permissionsInclude,
  sanitizeCustomRolePermissions,
  SYSTEM_ROLE_PERMISSIONS,
} from "../permissions.js";

describe("RBAC permission catalog (Owner + Admin system roles)", () => {
  it("owner and admin both include org.update (full matrix)", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.owner.includes("org.update")).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.admin.includes("org.update")).toBe(true);
  });

  it("owner and admin can manage roles", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.owner.includes("role.manage")).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.admin.includes("role.manage")).toBe(true);
  });

  it("only owner and admin are system seeds", () => {
    expect(Object.keys(SYSTEM_ROLE_PERMISSIONS).sort()).toEqual([
      "admin",
      "owner",
    ]);
  });

  it("sanitizeCustomRolePermissions allows org.update when requested", () => {
    const cleaned = sanitizeCustomRolePermissions([
      "vault.read",
      "org.update",
      "not-a-perm",
      "secret.reveal",
    ]);
    expect(cleaned).toEqual(["vault.read", "org.update", "secret.reveal"]);
  });

  it("ensureCustomRoleBaselinePermissions always adds org.read", async () => {
    const { ensureCustomRoleBaselinePermissions } = await import(
      "../permissions.js"
    );
    expect(ensureCustomRoleBaselinePermissions(["vault.read"])).toEqual([
      "org.read",
      "vault.read",
    ]);
    expect(
      ensureCustomRoleBaselinePermissions(["org.read", "secret.read"]),
    ).toContain("org.read");
  });

  it("clampPermissionsToActor respects actor ceiling", () => {
    const clamped = clampPermissionsToActor(
      ["vault.read", "secret.reveal", "member.remove"],
      ["vault.read", "secret.reveal"],
    );
    expect(clamped).toEqual(["vault.read", "secret.reveal"]);
  });

  it("permissionsInclude and isPermission helpers", () => {
    expect(isPermission("vault.read")).toBe(true);
    expect(isPermission("nope")).toBe(false);
    expect(permissionsInclude(["vault.read"], "vault.read")).toBe(true);
    expect(permissionsInclude(["vault.read"], "vault.delete")).toBe(false);
  });
});
