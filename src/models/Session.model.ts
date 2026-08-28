import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const SESSION_STATUSES = ["full", "mfa_pending"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const sessionSchema = new Schema(
  {
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: SESSION_STATUSES,
      default: "full",
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: 512,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    /**
     * MEDIUM risk freshness — last password re-authentication.
     * Null on mfa_pending sessions.
     */
    authFreshAt: {
      type: Date,
      default: null,
    },
    /**
     * HIGH risk freshness — last password + MFA factor (when MFA enabled).
     * When MFA is disabled, high freshness tracks the same password proof.
     * Null on mfa_pending sessions.
     */
    authHighFreshAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// MongoDB TTL: documents removed automatically after expiresAt
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDocument = InferSchemaType<typeof sessionSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Session: Model<SessionDocument> =
  mongoose.models.Session ??
  mongoose.model<SessionDocument>("Session", sessionSchema);
