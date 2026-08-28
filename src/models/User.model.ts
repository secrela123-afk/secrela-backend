import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { EncryptedTotpSecret } from "../lib/totpCrypto.js";

const encryptedTotpSchema = new Schema(
  {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    ct: { type: String, required: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    /** True after this account started a free trial — blocks another free signup. */
    freeTrialUsed: {
      type: Boolean,
      default: false,
    },
    /**
     * Set when removed from an organization.
     * Login/register blocked until they join again via a new invitation.
     */
    reinviteRequired: {
      type: Boolean,
      default: false,
    },
    passwordHash: {
      type: String,
      required: false,
      select: false,
      default: null,
    },
    /** Google OAuth subject — unique when set. */
    googleId: {
      type: String,
      default: null,
      sparse: true,
      unique: true,
      select: false,
    },
    authProvider: {
      type: String,
      enum: ["password", "google"],
      default: "password",
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    passwordResetTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    mfaEnabled: {
      type: Boolean,
      default: false,
    },
    totpSecretEnc: {
      type: encryptedTotpSchema,
      default: null,
      select: false,
    },
    totpPendingSecretEnc: {
      type: encryptedTotpSchema,
      default: null,
      select: false,
    },
    recoveryCodeHashes: {
      type: [String],
      default: [],
      select: false,
    },
    /** 6-digit email OTP while enabling MFA (hashed). */
    mfaEnableEmailCodeHash: {
      type: String,
      default: null,
      select: false,
    },
    mfaEnableEmailExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    /** After email OTP succeeds — window to run setup/enable. */
    mfaSetupAuthorizedUntil: {
      type: Date,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

export type UserDocument = InferSchemaType<typeof userSchema> & {
  _id: mongoose.Types.ObjectId;
  totpSecretEnc?: EncryptedTotpSecret | null;
  totpPendingSecretEnc?: EncryptedTotpSecret | null;
};

export const User: Model<UserDocument> =
  mongoose.models.User ?? mongoose.model<UserDocument>("User", userSchema);
