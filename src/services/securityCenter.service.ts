import { Membership } from "../models/Membership.model.js";
import { AccessRequest } from "../models/AccessRequest.model.js";
import { Secret } from "../models/Secret.model.js";
import { User } from "../models/User.model.js";
import { resolveRoleForMembership } from "./role.service.js";
import { assertPlanFeature } from "./planEntitlement.service.js";

const OLD_SECRET_DAYS = 90;

export type SecurityFindingSeverity = "high" | "medium" | "low";

export type SecurityFinding = {
  id: string;
  title: string;
  description: string;
  severity: SecurityFindingSeverity;
  count: number;
  href: string;
};

export type SecurityCenterResult = {
  score: number;
  label: string;
  risks: { high: number; medium: number; low: number };
  findings: SecurityFinding[];
  metrics: {
    activeMembers: number;
    mfaEnabledMembers: number;
    mfaCoveragePct: number;
    totalSecrets: number;
    highRiskSecrets: number;
    expiredSecrets: number;
    oldSecrets: number;
    pendingAccessRequests: number;
  };
};

function scoreLabel(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 50) return "Needs attention";
  return "At risk";
}

/**
 * Live Security Center snapshot — measurable rules only (no vanity metrics).
 */
export async function getSecurityCenterForOrganization(
  organizationId: string,
): Promise<SecurityCenterResult> {
  await assertPlanFeature(organizationId, "securityCenter");

  const now = Date.now();
  const oldCutoff = new Date(now - OLD_SECRET_DAYS * 24 * 60 * 60 * 1000);

  const memberships = await Membership.find({
    organizationId,
    status: { $ne: "disabled" },
  }).lean();

  const userIds = memberships.map((m) => m.userId);
  const users = await User.find({ _id: { $in: userIds } })
    .select("mfaEnabled")
    .lean();
  const mfaByUser = new Map(
    users.map((u) => [u._id.toString(), Boolean(u.mfaEnabled)]),
  );

  let mfaEnabledMembers = 0;
  for (const m of memberships) {
    if (mfaByUser.get(m.userId.toString())) mfaEnabledMembers += 1;
  }
  const activeMembers = memberships.length;
  const membersWithoutMfa = activeMembers - mfaEnabledMembers;
  const mfaCoveragePct =
    activeMembers === 0
      ? 100
      : Math.round((mfaEnabledMembers / activeMembers) * 100);

  const secrets = await Secret.find({ organizationId })
    .select("riskLevel expiresAt updatedAt")
    .lean();

  let highRiskSecrets = 0;
  let expiredSecrets = 0;
  let oldSecrets = 0;
  for (const s of secrets) {
    if (s.riskLevel === "high") highRiskSecrets += 1;
    if (s.expiresAt && new Date(s.expiresAt).getTime() < now) {
      expiredSecrets += 1;
    }
    if (new Date(s.updatedAt).getTime() < oldCutoff.getTime()) {
      oldSecrets += 1;
    }
  }

  const pendingAccessRequests = await AccessRequest.countDocuments({
    organizationId,
    status: "pending",
  });

  /** Members with permanent secret.reveal (non owner/admin) — hygiene signal. */
  let excessiveReveal = 0;
  for (const m of memberships) {
    const resolved = await resolveRoleForMembership(m);
    if (resolved.systemKey === "owner" || resolved.systemKey === "admin") {
      continue;
    }
    if (resolved.permissions.includes("secret.reveal")) {
      excessiveReveal += 1;
    }
  }

  const findings: SecurityFinding[] = [];

  if (membersWithoutMfa > 0) {
    findings.push({
      id: "mfa-missing",
      title: "Members without MFA",
      description: "Active members who have not enabled two-factor authentication.",
      severity: membersWithoutMfa >= 3 ? "high" : "medium",
      count: membersWithoutMfa,
      href: "/app/members",
    });
  }

  if (highRiskSecrets > 0) {
    findings.push({
      id: "high-risk-secrets",
      title: "High-risk secrets",
      description: "Secrets marked high risk — review ownership and access.",
      severity: "high",
      count: highRiskSecrets,
      href: "/app/secrets",
    });
  }

  if (expiredSecrets > 0) {
    findings.push({
      id: "expired-secrets",
      title: "Expired secrets",
      description: "Secrets past their expiry date still stored in vaults.",
      severity: "medium",
      count: expiredSecrets,
      href: "/app/secrets",
    });
  }

  if (oldSecrets > 0) {
    findings.push({
      id: "stale-secrets",
      title: `Secrets not updated in ${OLD_SECRET_DAYS}+ days`,
      description: "Stale credentials may need rotation or review.",
      severity: "low",
      count: oldSecrets,
      href: "/app/secrets",
    });
  }

  if (pendingAccessRequests > 0) {
    findings.push({
      id: "pending-access",
      title: "Pending access requests",
      description: "Temporary access waiting for Owner/Admin review.",
      severity: pendingAccessRequests >= 5 ? "medium" : "low",
      count: pendingAccessRequests,
      href: "/app/access-requests",
    });
  }

  if (excessiveReveal > 0) {
    findings.push({
      id: "excessive-reveal",
      title: "Broad reveal permissions",
      description:
        "Non-admin members with permanent secret.reveal — prefer temporary access.",
      severity: "medium",
      count: excessiveReveal,
      href: "/app/roles",
    });
  }

  // Score: start 100, subtract weighted penalties (floor 0).
  let score = 100;
  if (activeMembers > 0) {
    score -= Math.round(((100 - mfaCoveragePct) / 100) * 35);
  }
  score -= Math.min(25, highRiskSecrets * 5);
  score -= Math.min(15, expiredSecrets * 3);
  score -= Math.min(10, oldSecrets * 1);
  score -= Math.min(10, pendingAccessRequests * 2);
  score -= Math.min(10, excessiveReveal * 4);
  score = Math.max(0, Math.min(100, score));

  const risks = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    risks[f.severity] += f.count;
  }

  return {
    score,
    label: scoreLabel(score),
    risks,
    findings,
    metrics: {
      activeMembers,
      mfaEnabledMembers,
      mfaCoveragePct,
      totalSecrets: secrets.length,
      highRiskSecrets,
      expiredSecrets,
      oldSecrets,
      pendingAccessRequests,
    },
  };
}
