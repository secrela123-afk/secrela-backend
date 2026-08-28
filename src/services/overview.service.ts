import { AccessRequest } from "../models/AccessRequest.model.js";
import { AuditLog } from "../models/AuditLog.model.js";
import { Membership } from "../models/Membership.model.js";
import { Secret } from "../models/Secret.model.js";
import { User } from "../models/User.model.js";
import { Vault } from "../models/Vault.model.js";
import {
  auditRetentionCutoff,
  loadOrganizationPlanContext,
} from "./planEntitlement.service.js";
import { getSecurityCenterForOrganization } from "./securityCenter.service.js";
import { expireStaleGrants } from "./accessRequest.service.js";

const VAULT_COLOR_TOKENS = [
  "brand-primary",
  "info",
  "warning",
  "purple",
  "danger",
] as const;

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function formatRelative(at: Date): string {
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return at.toLocaleDateString();
}

export type OverviewResult = {
  metrics: {
    securityScore: number | null;
    securityLabel: string | null;
    totalSecrets: number;
    vaults: number;
    members: number;
    accessRequestsTotal: number;
    accessPending: number;
    highRiskSecrets: number;
  };
  risks: { high: number; medium: number; low: number } | null;
  vaultSlices: Array<{
    id: string;
    name: string;
    count: number;
    percent: number;
    colorToken: (typeof VAULT_COLOR_TOKENS)[number];
  }>;
  recentActivity: Array<{
    id: string;
    actorName: string;
    initials: string;
    action: string;
    target: string;
    timeAgo: string;
  }>;
  pendingRequests: Array<{
    id: string;
    requesterName: string;
    requesterInitials: string;
    secretName: string;
    requestedAt: string;
  }>;
  topSecrets: Array<{
    id: string;
    name: string;
    vaultName: string;
    riskLevel: string;
    lastAccessedAt: string | null;
  }>;
  expiringSoon: Array<{
    id: string;
    name: string;
    expiresAt: string;
  }>;
};

/**
 * Dashboard snapshot for /app Overview — live org data only.
 */
export async function getOverviewForOrganization(
  organizationId: string,
  options?: {
    /** Owner/admin or audit.read — subject to plan entitlements */
    mayViewSecurityMetrics?: boolean;
    /** Owner/admin */
    mayViewAccessRequests?: boolean;
    /** Owner/admin or audit.read — subject to audit log plan */
    mayViewAuditActivity?: boolean;
  },
): Promise<OverviewResult> {
  await expireStaleGrants(organizationId);

  const { entitlements } = await loadOrganizationPlanContext(organizationId);

  const includeSecurity =
    (options?.mayViewSecurityMetrics ?? false) && entitlements.securityCenter;
  const includeAudit =
    (options?.mayViewAuditActivity ?? false) && entitlements.auditLogAccess;
  const includeAccess = options?.mayViewAccessRequests ?? false;

  const [vaults, secrets, membersCount, accessPending, accessRequestsTotal, security] =
    await Promise.all([
      Vault.find({ organizationId }).select("name color").lean(),
      Secret.find({ organizationId })
        .select("name vaultId riskLevel expiresAt lastAccessedAt updatedAt")
        .lean(),
      Membership.countDocuments({
        organizationId,
        status: { $ne: "disabled" },
      }),
      includeAccess
        ? AccessRequest.countDocuments({ organizationId, status: "pending" })
        : Promise.resolve(0),
      includeAccess
        ? AccessRequest.countDocuments({ organizationId })
        : Promise.resolve(0),
      includeSecurity
        ? getSecurityCenterForOrganization(organizationId)
        : Promise.resolve(null),
    ]);

  const vaultNameById = new Map(
    vaults.map((v) => [v._id.toString(), v.name as string]),
  );

  const countByVault = new Map<string, number>();
  let highRiskSecrets = 0;
  for (const s of secrets) {
    const vid = s.vaultId.toString();
    countByVault.set(vid, (countByVault.get(vid) ?? 0) + 1);
    if (s.riskLevel === "high") highRiskSecrets += 1;
  }

  const totalSecrets = secrets.length;
  const vaultSlices = vaults
    .map((v, i) => {
      const count = countByVault.get(v._id.toString()) ?? 0;
      return {
        id: v._id.toString(),
        name: v.name as string,
        count,
        percent:
          totalSecrets === 0 ? 0 : Math.round((count / totalSecrets) * 100),
        colorToken: VAULT_COLOR_TOKENS[i % VAULT_COLOR_TOKENS.length]!,
      };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const slices =
    vaultSlices.length > 0
      ? vaultSlices
      : vaults.slice(0, 5).map((v, i) => ({
          id: v._id.toString(),
          name: v.name as string,
          count: 0,
          percent: 0,
          colorToken: VAULT_COLOR_TOKENS[i % VAULT_COLOR_TOKENS.length]!,
        }));

  let recentActivity: OverviewResult["recentActivity"] = [];
  if (includeAudit) {
    const retentionFrom = auditRetentionCutoff(entitlements);
    const auditFilter: Record<string, unknown> = { organizationId };
    if (retentionFrom) {
      auditFilter.createdAt = { $gte: retentionFrom };
    }
    const logs = await AuditLog.find(auditFilter)
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();
    recentActivity = logs.map((row) => ({
      id: row._id.toString(),
      actorName: row.actorName,
      initials: initials(row.actorName),
      action: String(row.action).replace(/\./g, " "),
      target: row.targetLabel || "—",
      timeAgo: formatRelative(row.createdAt as Date),
    }));
  }

  let pendingRequests: OverviewResult["pendingRequests"] = [];
  if (includeAccess && accessPending > 0) {
    const pending = await AccessRequest.find({
      organizationId,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const requesterIds = [
      ...new Set(pending.map((p) => p.requesterUserId.toString())),
    ];
    const secretIds = [...new Set(pending.map((p) => p.secretId.toString()))];
    const [requesters, secretRows] = await Promise.all([
      User.find({ _id: { $in: requesterIds } }).select("name").lean(),
      Secret.find({ _id: { $in: secretIds } }).select("name").lean(),
    ]);
    const nameByUser = new Map(
      requesters.map((u) => [u._id.toString(), u.name as string]),
    );
    const nameBySecret = new Map(
      secretRows.map((s) => [s._id.toString(), s.name as string]),
    );

    pendingRequests = pending.map((p) => {
      const requesterName =
        nameByUser.get(p.requesterUserId.toString()) ?? "Member";
      return {
        id: p._id.toString(),
        requesterName,
        requesterInitials: initials(requesterName),
        secretName: nameBySecret.get(p.secretId.toString()) ?? "Secret",
        requestedAt: (p.createdAt as Date).toISOString(),
      };
    });
  }

  const topSecrets = [...secrets]
    .sort((a, b) => {
      const aT = a.lastAccessedAt
        ? new Date(a.lastAccessedAt).getTime()
        : 0;
      const bT = b.lastAccessedAt
        ? new Date(b.lastAccessedAt).getTime()
        : 0;
      return bT - aT;
    })
    .slice(0, 5)
    .map((s) => ({
      id: s._id.toString(),
      name: s.name as string,
      vaultName: vaultNameById.get(s.vaultId.toString()) ?? "Vault",
      riskLevel: (s.riskLevel as string) ?? "unknown",
      lastAccessedAt: s.lastAccessedAt
        ? new Date(s.lastAccessedAt).toISOString()
        : null,
    }));

  const now = Date.now();
  const in14d = now + 14 * 24 * 60 * 60 * 1000;
  const expiringSoon = secrets
    .filter((s) => {
      if (!s.expiresAt) return false;
      const t = new Date(s.expiresAt).getTime();
      return t >= now && t <= in14d;
    })
    .sort(
      (a, b) =>
        new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime(),
    )
    .slice(0, 5)
    .map((s) => ({
      id: s._id.toString(),
      name: s.name as string,
      expiresAt: new Date(s.expiresAt!).toISOString(),
    }));

  return {
    metrics: {
      securityScore: security?.score ?? null,
      securityLabel: security?.label ?? null,
      totalSecrets,
      vaults: vaults.length,
      members: membersCount,
      accessRequestsTotal,
      accessPending,
      highRiskSecrets,
    },
    risks: security?.risks ?? null,
    vaultSlices: slices,
    recentActivity,
    pendingRequests,
    topSecrets,
    expiringSoon,
  };
}
