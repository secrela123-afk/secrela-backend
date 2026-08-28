import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Append-only security events for an organization.
 * Never store secret values, passwords, tokens, or ciphertext.
 */
export const AUDIT_ACTIONS = [
  "login.success",
  "login.failed",
  "logout",
  "vault.created",
  "vault.updated",
  "vault.deleted",
  "secret.created",
  "secret.updated",
  "secret.deleted",
  "secret.revealed",
  "access.requested",
  "access.approved",
  "access.denied",
  "access.revoked",
  "member.invited",
  "member.removed",
  "member.role.updated",
  "mfa.enabled",
  "mfa.disabled",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  "secret",
  "vault",
  "access_request",
  "member",
  "invitation",
  "user",
  "session",
  "organization",
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

const auditLogSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    /** Snapshot — stays readable if the user is later removed. */
    actorName: {
      type: String,
      required: true,
      maxlength: 120,
    },
    actorEmail: {
      type: String,
      default: "",
      maxlength: 254,
    },
    targetType: {
      type: String,
      enum: AUDIT_TARGET_TYPES,
      default: null,
    },
    targetId: {
      type: String,
      default: null,
      maxlength: 64,
    },
    targetLabel: {
      type: String,
      default: "",
      maxlength: 200,
    },
    ip: {
      type: String,
      default: null,
      maxlength: 64,
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: 512,
    },
    /** Safe metadata only — never secret plaintext. */
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ organizationId: 1, action: 1, createdAt: -1 });

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const AuditLog: Model<AuditLogDocument> =
  mongoose.models.AuditLog ??
  mongoose.model<AuditLogDocument>("AuditLog", auditLogSchema);
