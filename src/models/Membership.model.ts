import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** Workspace access state — disabled members keep the row but cannot use the app. */
export const MEMBERSHIP_STATUSES = ["active", "disabled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * @deprecated Legacy enum kept only for one-time migration to roleId.
 * New code must use roleId → Role document.
 */
export const LEGACY_MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type LegacyMembershipRole = (typeof LEGACY_MEMBERSHIP_ROLES)[number];

/** @deprecated Use SystemRoleKey from Role.model — alias for gradual migration. */
export type MembershipRole = LegacyMembershipRole;
export const MEMBERSHIP_ROLES = LEGACY_MEMBERSHIP_ROLES;

const membershipSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: false,
      index: true,
    },
    /**
     * Legacy string role — migrated to roleId by ensureOrganizationRoles.
     * Do not use for authorization.
     */
    role: {
      type: String,
      enum: LEGACY_MEMBERSHIP_ROLES,
      required: false,
    },
    status: {
      type: String,
      enum: MEMBERSHIP_STATUSES,
      required: true,
      default: "active",
      index: true,
    },
    /** Consecutive denied access requests (resets on approve). */
    accessRequestConsecutiveDenials: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** After 3 consecutive denials — cannot request/reveal-via-request until this time. */
    accessRequestBlockedUntil: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export type MembershipDocument = InferSchemaType<typeof membershipSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Membership: Model<MembershipDocument> =
  mongoose.models.Membership ??
  mongoose.model<MembershipDocument>("Membership", membershipSchema);
