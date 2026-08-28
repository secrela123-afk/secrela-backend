import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { Permission } from "../lib/permissions.js";

export const ROLE_KINDS = ["system", "custom"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** Active system roles seeded per organization. */
export const SYSTEM_ROLE_KEYS = ["owner", "admin"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** Includes legacy "member" so old Role documents still validate. */
export const ROLE_SYSTEM_KEY_ENUM = ["owner", "admin", "member"] as const;

const roleSchema = new Schema(
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
      maxlength: 80,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
    },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    permissions: {
      type: [String],
      required: true,
      default: [],
    },
    kind: {
      type: String,
      enum: ROLE_KINDS,
      required: true,
      default: "custom",
      index: true,
    },
    systemKey: {
      type: String,
      enum: ROLE_SYSTEM_KEY_ENUM,
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

roleSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
roleSchema.index(
  { organizationId: 1, systemKey: 1 },
  {
    unique: true,
    partialFilterExpression: { systemKey: { $type: "string" } },
  },
);

export type RoleDocument = InferSchemaType<typeof roleSchema> & {
  _id: mongoose.Types.ObjectId;
  permissions: Permission[];
};

export const Role: Model<RoleDocument> =
  mongoose.models.Role ?? mongoose.model<RoleDocument>("Role", roleSchema);
