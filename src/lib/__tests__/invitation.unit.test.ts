import { describe, expect, it } from "vitest";
import {
  acceptInvitationBodySchema,
  createInvitationBodySchema,
} from "../../schemas/invitation.schemas.js";
import { buildOrganizationInviteEmail } from "../email/templates.js";

describe("invitation create schema", () => {
  it("requires email + roleId", () => {
    const ok = createInvitationBodySchema.safeParse({
      email: "Alex@Example.com",
      roleId: "507f1f77bcf86cd799439011",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.email).toBe("alex@example.com");
      expect(ok.data.roleId).toBe("507f1f77bcf86cd799439011");
    }

    const missingRole = createInvitationBodySchema.safeParse({
      email: "alex@example.com",
    });
    expect(missingRole.success).toBe(false);
  });
});

describe("accept invitation schema", () => {
  it("requires a non-trivial token", () => {
    expect(
      acceptInvitationBodySchema.safeParse({ token: "short" }).success,
    ).toBe(false);
    expect(
      acceptInvitationBodySchema.safeParse({
        token: "a".repeat(32),
      }).success,
    ).toBe(true);
  });
});

describe("organization invite email", () => {
  it("includes org, role, and accept URL", () => {
    const content = buildOrganizationInviteEmail({
      inviterName: "Sara Owner",
      organizationName: "Acme Security",
      roleName: "Member",
      acceptUrl: "http://localhost:3000/invite/accept?token=abc",
    });

    expect(content.subject).toMatch(/Confirm your .+ invitation/i);
    expect(content.text).toContain("Sara Owner");
    expect(content.text).toContain("Acme Security");
    expect(content.text).toContain("Member");
    expect(content.text).toContain(
      "http://localhost:3000/invite/accept?token=abc",
    );
    expect(content.html).toContain("Confirm invitation");
  });
});
