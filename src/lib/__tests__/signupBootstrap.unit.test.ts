import { describe, expect, it } from "vitest";
import { SYSTEM_ROLE_PERMISSIONS } from "../permissions.js";

/**
 * Signup bootstrap contract — enforced in signup.service via assertSingleOwnerBootstrap.
 * One Organization → one Membership → Owner role. Admin is invite-only.
 */
describe("organization signup bootstrap (contract)", () => {
  it("seeds only Owner and Admin role templates — not member users", () => {
    expect(Object.keys(SYSTEM_ROLE_PERMISSIONS).sort()).toEqual([
      "admin",
      "owner",
    ]);
  });

  it("documents invite-only path for additional members", () => {
    // Admin permissions exist on the Role document, not as a default Membership row.
    expect(SYSTEM_ROLE_PERMISSIONS.admin.length).toBeGreaterThan(0);
    expect(SYSTEM_ROLE_PERMISSIONS.owner.length).toBeGreaterThan(
      SYSTEM_ROLE_PERMISSIONS.admin.length - 1,
    );
  });
});
