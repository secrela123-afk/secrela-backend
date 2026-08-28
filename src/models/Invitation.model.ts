import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

const invitationSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    /** Assigned Role document (never the owner system role). */
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: true,
      index: true,
    },
    /** Denormalized role name for emails / previews. */
    roleName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    /**
     * @deprecated Legacy invite role string — kept for reading old documents.
     */
    role: {
      type: String,
      required: false,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: INVITATION_STATUSES,
      required: true,
      default: "pending",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

invitationSchema.index(
  { organizationId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  },
);

export type InvitationDocument = InferSchemaType<typeof invitationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Invitation: Model<InvitationDocument> =
  mongoose.models.Invitation ??
  mongoose.model<InvitationDocument>("Invitation", invitationSchema);

/** @deprecated Use roleId on invites. */
export const INVITEABLE_ROLES = ["admin", "member"] as const;
export type InviteableRole = (typeof INVITEABLE_ROLES)[number];
