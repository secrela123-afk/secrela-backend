import { z } from "zod";
import { PLAN_SLUGS } from "../lib/subscriptionPlans.js";

export const registerBodySchema = z.object({
  email: z.email().max(320),
  /** Company / workspace name at signup. Stored as user display name for MVP. */
  companyName: z.string().trim().min(1).max(120),
  /** Company phone — required when creating an organization workspace. */
  phone: z
    .string()
    .trim()
    .min(7, "Phone number is too short")
    .max(40)
    .regex(/^[+0-9()\-\s]+$/, "Enter a valid phone number")
    .optional(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128)
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/\d/, "Password must include a number")
    .regex(/[^A-Za-z0-9]/, "Password must include a special character"),
  plan: z.enum(PLAN_SLUGS).optional(),
  /** When false, only the user account is created (e.g. invite acceptance). */
  createOrganization: z.boolean().optional().default(true),
}).superRefine((data, ctx) => {
  if (data.createOrganization !== false && !data.phone?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["phone"],
      message: "Phone number is required",
    });
  }
});

export const loginBodySchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(128),
  /** Required when account was removed from an org — must come from a new invite link. */
  inviteToken: z.string().min(20).max(200).optional(),
});

export const verifyEmailBodySchema = z.object({
  token: z.string().min(20).max(200),
});

export const mfaCodeBodySchema = z.object({
  code: z.string().trim().min(6).max(20),
});

export const mfaEnableStartBodySchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(128),
});

export const mfaEnableVerifyEmailBodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit email code"),
});

export const reauthenticateBodySchema = z.object({
  password: z.string().min(1).max(128),
  /** Required for HIGH when MFA is enabled (TOTP or recovery). */
  code: z.string().trim().min(6).max(20).optional(),
  /**
   * medium = password only
   * high   = password + MFA factor when MFA enabled
   */
  level: z.enum(["medium", "high"]).default("medium"),
});

export const forgotPasswordBodySchema = z.object({
  email: z.email().max(320),
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(20).max(200),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128)
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/\d/, "Password must include a number")
    .regex(/[^A-Za-z0-9]/, "Password must include a special character"),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;
export type MfaCodeBody = z.infer<typeof mfaCodeBodySchema>;
export type MfaEnableStartBody = z.infer<typeof mfaEnableStartBodySchema>;
export type MfaEnableVerifyEmailBody = z.infer<
  typeof mfaEnableVerifyEmailBodySchema
>;
export type ReauthenticateBody = z.infer<typeof reauthenticateBodySchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
