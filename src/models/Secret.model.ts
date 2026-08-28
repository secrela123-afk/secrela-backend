import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const SECRET_TYPES = [
  "credential",
  "api_key",
  "database",
  "token",
  "key_pair",
  "other",
] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export const SECRET_RISK_LEVELS = [
  "unknown",
  "low",
  "medium",
  "high",
] as const;
export type SecretRiskLevel = (typeof SECRET_RISK_LEVELS)[number];

export const SECRET_STATUSES = ["active", "expired"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

const encryptedBlobSchema = new Schema(
  {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    ct: { type: String, required: true },
  },
  { _id: false },
);

const secretSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    vaultId: {
      type: Schema.Types.ObjectId,
      ref: "Vault",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    type: {
      type: String,
      enum: SECRET_TYPES,
      required: true,
      index: true,
    },
    riskLevel: {
      type: String,
      enum: SECRET_RISK_LEVELS,
      default: "unknown",
      index: true,
    },
    /** Ciphertext only — never plaintext. */
    valueEnc: {
      type: encryptedBlobSchema,
      required: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastAccessedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

secretSchema.index({ organizationId: 1, vaultId: 1, name: 1 }, { unique: true });
secretSchema.index({ organizationId: 1, updatedAt: -1 });

export type SecretDocument = InferSchemaType<typeof secretSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Secret: Model<SecretDocument> =
  mongoose.models.Secret ??
  mongoose.model<SecretDocument>("Secret", secretSchema);
