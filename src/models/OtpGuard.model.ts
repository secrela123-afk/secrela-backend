import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const otpGuardSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /** e.g. `verify` (wrong-code lockout) or `mfa_enable_send` (resend cooldown) */
    scope: {
      type: String,
      required: true,
      trim: true,
    },
    failedAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Each tier doubles ban duration after every 3 failures (0 → 15m, 1 → 30m, …). */
    banTier: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    lastSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

otpGuardSchema.index({ userId: 1, scope: 1 }, { unique: true });

export type OtpGuardDocument = InferSchemaType<typeof otpGuardSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const OtpGuard: Model<OtpGuardDocument> =
  mongoose.models.OtpGuard ??
  mongoose.model<OtpGuardDocument>("OtpGuard", otpGuardSchema);
