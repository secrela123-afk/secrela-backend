import { describe, expect, it } from "vitest";
import { auditRetentionCutoff } from "../../services/planEntitlement.service.js";
import {
  PLAN_ENTITLEMENTS,
  getPlanEntitlements,
  recommendedUpgradeForFeature,
  recommendedUpgradePlan,
  resolvePlanSlug,
} from "../planEntitlements.js";

describe("planEntitlements", () => {
  it("maps unknown slug to free", () => {
    expect(resolvePlanSlug(undefined)).toBe("free");
    expect(resolvePlanSlug("invalid")).toBe("free");
  });

  it("free tier matches landing starter card limits", () => {
    const e = getPlanEntitlements("free");
    expect(e.maxMembers).toBe(1);
    expect(e.maxVaults).toBe(3);
    expect(e.maxSecrets).toBe(100);
    expect(e.auditLogAccess).toBe(false);
    expect(e.customRoles).toBe(false);
  });

  it("starter tier allows 5 members and 7-day audit", () => {
    const e = getPlanEntitlements("starter");
    expect(e.maxMembers).toBe(5);
    expect(e.auditLogAccess).toBe(true);
    expect(e.auditRetentionDays).toBe(7);
    expect(e.customRoles).toBe(true);
  });

  it("team tier unlocks security center and integrations", () => {
    const e = getPlanEntitlements("team");
    expect(e.maxMembers).toBe(10);
    expect(e.securityCenter).toBe(true);
    expect(e.integrations).toBe(true);
    expect(e.auditRetentionDays).toBeNull();
  });

  it("business tier allows 25 members with Team security features", () => {
    const e = getPlanEntitlements("business");
    expect(e.maxMembers).toBe(25);
    expect(e.securityCenter).toBe(true);
    expect(e.integrations).toBe(true);
    expect(e.auditRetentionDays).toBeNull();
  });

  it("enterprise is unlimited (legacy / sales)", () => {
    const e = getPlanEntitlements("enterprise");
    expect(e.maxMembers).toBeNull();
    expect(e.maxVaults).toBeNull();
    expect(e.maxSecrets).toBeNull();
  });

  it("suggests feature-specific upgrade path", () => {
    expect(recommendedUpgradeForFeature("free", "securityCenter")).toBe("team");
    expect(recommendedUpgradeForFeature("starter", "securityCenter")).toBe("team");
    expect(recommendedUpgradeForFeature("free", "auditLogs")).toBe("starter");
  });

  it("suggests upgrade path", () => {
    expect(recommendedUpgradePlan("free")).toBe("starter");
    expect(recommendedUpgradePlan("starter")).toBe("team");
    expect(recommendedUpgradePlan("team")).toBe("business");
    expect(recommendedUpgradePlan("business")).toBeNull();
    expect(recommendedUpgradePlan("enterprise")).toBeNull();
  });

  it("defines all plan slugs", () => {
    for (const slug of [
      "free",
      "starter",
      "team",
      "business",
      "enterprise",
    ] as const) {
      expect(PLAN_ENTITLEMENTS[slug]).toBeDefined();
    }
  });

  it("audit retention cutoff matches plan", () => {
    expect(auditRetentionCutoff(getPlanEntitlements("free"))).toBeNull();
    const starterCutoff = auditRetentionCutoff(getPlanEntitlements("starter"));
    expect(starterCutoff).toBeInstanceOf(Date);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(Date.now() - starterCutoff!.getTime()).toBeGreaterThanOrEqual(
      sevenDaysMs - 5000,
    );
    expect(auditRetentionCutoff(getPlanEntitlements("team"))).toBeNull();
    expect(auditRetentionCutoff(getPlanEntitlements("business"))).toBeNull();
    expect(auditRetentionCutoff(getPlanEntitlements("enterprise"))).toBeNull();
  });
});
