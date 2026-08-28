import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** MVP: temporary right to reveal/use a secret. */
export const ACCESS_PERMISSIONS = ["use"] as const;
export type AccessPermission = (typeof ACCESS_PERMISSIONS)[number];

export const ACCESS_DURATION_MINUTES = [
  15, 30, 60, 120, 240, 480, 720, 1440,
] as const;
export type AccessDurationMinutes = (typeof ACCESS_DURATION_MINUTES)[number];

const accessRequestSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    requesterUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    secretId: {
      type: Schema.Types.ObjectId,
      ref: "Secret",
      required: true,
      index: true,
    },
    permission: {
      type: String,
      enum: ACCESS_PERMISSIONS,
      default: "use",
    },
    durationMinutes: {
      type: Number,
      required: true,
      enum: [...ACCESS_DURATION_MINUTES],
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ACCESS_REQUEST_STATUSES,
      default: "pending",
      index: true,
    },
    reviewedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    /** Set when approved — grant ends at this time. */
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    grantedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

accessRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
accessRequestSchema.index({
  organizationId: 1,
  requesterUserId: 1,
  secretId: 1,
  status: 1,
});

export type AccessRequestDocument = InferSchemaType<
  typeof accessRequestSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const AccessRequest: Model<AccessRequestDocument> =
  mongoose.models.AccessRequest ??
  mongoose.model<AccessRequestDocument>("AccessRequest", accessRequestSchema);
