import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** Accent used for the vault icon tile in the UI (maps to design tokens). */
export const VAULT_COLORS = [
  "brand",
  "purple",
  "info",
  "warning",
  "danger",
] as const;
export type VaultColor = (typeof VAULT_COLORS)[number];

/**
 * Risk is Unknown until secrets exist and risk rules run.
 * Manual override allowed later; MVP defaults to unknown.
 */
export const VAULT_RISK_LEVELS = ["unknown", "low", "medium", "high"] as const;
export type VaultRiskLevel = (typeof VAULT_RISK_LEVELS)[number];

const vaultSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    color: {
      type: String,
      enum: VAULT_COLORS,
      default: "brand",
    },
    riskLevel: {
      type: String,
      enum: VAULT_RISK_LEVELS,
      default: "unknown",
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
  },
  { timestamps: true },
);

vaultSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export type VaultDocument = InferSchemaType<typeof vaultSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Vault: Model<VaultDocument> =
  mongoose.models.Vault ?? mongoose.model<VaultDocument>("Vault", vaultSchema);
