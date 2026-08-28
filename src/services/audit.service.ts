import type { Request } from "express";
import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import { getRequestClientMeta } from "../lib/requestClient.js";
import {
  AuditLog,
  type AuditAction,
  type AuditTargetType,
} from "../models/AuditLog.model.js";
import { Membership } from "../models/Membership.model.js";
import { notifyOwnersAndAdmins } from "./notification.service.js";
import {
  assertPlanFeature,
  auditRetentionCutoff,
} from "./planEntitlement.service.js";

export type RecordAuditInput = {
  organizationId: string;
  action: AuditAction;
  actorUserId?: string | null;
  actorName: string;
  actorEmail?: string;
  targetType?: AuditTargetType | null;
  targetId?: string | null;
  targetLabel?: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * When true, skip Owner/Admin bell notification.
   * Used for access.requested — already has a dedicated review notification.
   */
  skipOwnerNotification?: boolean;
};

export type AuditLogDto = {
  id: string;
  action: AuditAction;
  actor: {
    id: string | null;
    name: string;
    email: string;
    initials: string;
  };
  targetType: AuditTargetType | null;
  targetId: string | null;
  targetLabel: string;
  ip: string | null;
  createdAt: string;
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

const AUDIT_ACTION_TITLES: Record<AuditAction, string> = {
  "login.success": "Successful login",
  "login.failed": "Failed login attempt",
  logout: "User signed out",
  "vault.created": "Vault created",
  "vault.updated": "Vault updated",
  "vault.deleted": "Vault deleted",
  "secret.created": "Secret created",
  "secret.updated": "Secret updated",
  "secret.deleted": "Secret deleted",
  "secret.revealed": "Secret revealed",
  "access.requested": "Access requested",
  "access.approved": "Access approved",
  "access.denied": "Access denied",
  "access.revoked": "Access revoked",
  "member.invited": "Member invited",
  "member.removed": "Member removed",
  "member.role.updated": "Member role updated",
  "mfa.enabled": "MFA enabled",
  "mfa.disabled": "MFA disabled",
};

/** Actions that already notify Owner/Admin via a dedicated flow. */
const SKIP_OWNER_NOTIFY_ACTIONS = new Set<AuditAction>(["access.requested"]);

function auditNotificationBody(input: RecordAuditInput): string {
  const actor = input.actorName || "Someone";
  const target = input.targetLabel?.trim();
  if (target) return `${actor} · ${target}`;
  return actor;
}

/**
 * Persist one audit row. Never throws to callers — audit must not break
 * the primary security action (reveal, approve, login, …).
 * Also notifies Owner/Admin (bell) except when skipped / actor-only org.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    if (!mongoose.isValidObjectId(input.organizationId)) return;

    await AuditLog.create({
      organizationId: input.organizationId,
      action: input.action,
      actorUserId: input.actorUserId
        ? new mongoose.Types.ObjectId(input.actorUserId)
        : null,
      actorName: input.actorName.slice(0, 120) || "Unknown",
      actorEmail: (input.actorEmail ?? "").slice(0, 254),
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetLabel: (input.targetLabel ?? "").slice(0, 200),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    console.error("[audit] failed to record event", {
      action: input.action,
      organizationId: input.organizationId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return;
  }

  const skipNotify =
    input.skipOwnerNotification === true ||
    SKIP_OWNER_NOTIFY_ACTIONS.has(input.action);

  if (skipNotify) return;

  try {
    await notifyOwnersAndAdmins({
      organizationId: input.organizationId,
      type: "audit.event",
      title: AUDIT_ACTION_TITLES[input.action] ?? input.action,
      body: auditNotificationBody(input),
      href: "/app/audit",
      excludeUserId: input.actorUserId ?? undefined,
      meta: {
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? "",
      },
    });
  } catch (err) {
    console.error("[audit] failed to notify owners/admins", {
      action: input.action,
      organizationId: input.organizationId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

/** Actor + client meta from an authenticated org request. */
export function auditContextFromRequest(req: Request): {
  actorUserId: string | null;
  actorName: string;
  actorEmail: string;
  ip: string | null;
  userAgent: string | null;
} {
  const client = getRequestClientMeta(req);
  return {
    actorUserId: req.authUser?.id ?? null,
    actorName: req.authUser?.name ?? "Unknown",
    actorEmail: req.authUser?.email ?? "",
    ip: client.ip,
    userAgent: client.userAgent,
  };
}

/** Write the same auth event into every active org membership for this user. */
export async function recordAuditForUserOrganizations(input: {
  userId: string;
  actorName: string;
  actorEmail?: string;
  action: Extract<
    AuditAction,
    "login.success" | "login.failed" | "logout" | "mfa.enabled" | "mfa.disabled"
  >;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const memberships = await Membership.find({
      userId: input.userId,
      status: "active",
    })
      .select("organizationId")
      .lean();

    await Promise.all(
      memberships.map((m) =>
        recordAudit({
          organizationId: m.organizationId.toString(),
          action: input.action,
          actorUserId: input.userId,
          actorName: input.actorName,
          actorEmail: input.actorEmail,
          targetType: "user",
          targetId: input.userId,
          targetLabel: input.actorEmail || input.actorName,
          ip: input.ip,
          userAgent: input.userAgent,
          metadata: input.metadata,
        }),
      ),
    );
  } catch (err) {
    console.error("[audit] failed to fan-out user org events", {
      action: input.action,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

export type AuditLogsListResult = {
  events: AuditLogDto[];
  retention: {
    limited: boolean;
    days: number | null;
    cutoffAt: string | null;
  };
};

export async function listAuditLogsForOrganization(
  organizationId: string,
  options?: { limit?: number; action?: string },
): Promise<AuditLogsListResult> {
  const entitlements = await assertPlanFeature(organizationId, "auditLogs");
  const retentionFrom = auditRetentionCutoff(entitlements);

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const filter: Record<string, unknown> = { organizationId };
  if (options?.action) {
    filter.action = options.action;
  }
  if (retentionFrom) {
    filter.createdAt = { $gte: retentionFrom };
  }

  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const events: AuditLogDto[] = rows.map((row) => ({
    id: row._id.toString(),
    action: row.action as AuditAction,
    actor: {
      id: row.actorUserId ? row.actorUserId.toString() : null,
      name: row.actorName,
      email: row.actorEmail ?? "",
      initials: initials(row.actorName),
    },
    targetType: (row.targetType as AuditTargetType | null) ?? null,
    targetId: row.targetId ?? null,
    targetLabel: row.targetLabel ?? "",
    ip: row.ip ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
  }));

  return {
    events,
    retention: {
      limited: retentionFrom !== null,
      days: entitlements.auditRetentionDays,
      cutoffAt: retentionFrom?.toISOString() ?? null,
    },
  };
}

export function requireAuditOrganizationId(req: Request): string {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.organizationId;
}
