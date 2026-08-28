import { z } from "zod";
import {
  COMPANY_SIZES,
  ORGANIZATION_TYPES,
} from "../models/Organization.model.js";
import { BILLING_INTERVALS, PLAN_SLUGS } from "../lib/subscriptionPlans.js";

const optionalNullableString = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal(""), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v;
    });

export const createOrganizationBodySchema = z.object({
  name: z.string().trim().min(2, "Organization name is too short").max(120),
  type: z.enum(ORGANIZATION_TYPES).optional().default("other"),
  phone: z
    .string()
    .trim()
    .min(7, "Phone number is too short")
    .max(40)
    .regex(/^[+0-9()\-\s]+$/, "Enter a valid phone number"),
});

export const updateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  type: z.enum(ORGANIZATION_TYPES).optional(),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(40)
    .regex(/^[+0-9()\-\s]+$/)
    .optional(),
  website: optionalNullableString(320),
  country: optionalNullableString(80),
  companySize: z
    .union([z.enum(COMPANY_SIZES), z.literal(""), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v;
    }),
  industry: optionalNullableString(120),
  billingEmail: z
    .union([z.email().max(320), z.literal(""), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return typeof v === "string" ? v.toLowerCase() : v;
    }),
  address: optionalNullableString(400),
});

export const extendTrialBodySchema = z.object({
  days: z
    .number()
    .int()
    .min(1, "Add at least 1 day")
    .max(7, "Add at most 7 days per request"),
});

export const activateSubscriptionBodySchema = z.object({
  planSlug: z.enum(PLAN_SLUGS),
  interval: z.enum(BILLING_INTERVALS),
});

export const updateAutoRenewBodySchema = z.object({
  autoRenew: z.boolean(),
  autoRenewInterval: z.enum(BILLING_INTERVALS).nullable().optional(),
});

/** Assign a Role document (not owner). */
export const updateMemberRoleBodySchema = z.object({
  roleId: z.string().min(1, "Select a role"),
});

export type CreateOrganizationBody = z.infer<typeof createOrganizationBodySchema>;
export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;
export type ExtendTrialBody = z.infer<typeof extendTrialBodySchema>;
export type ActivateSubscriptionBody = z.infer<
  typeof activateSubscriptionBodySchema
>;
export type UpdateAutoRenewBody = z.infer<typeof updateAutoRenewBodySchema>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBodySchema>;

export const createRoleBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z
    .union([z.string().trim().max(300), z.literal(""), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v;
    }),
  permissions: z.array(z.string()).min(1),
});

export const updateRoleBodySchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z
    .union([z.string().trim().max(300), z.literal(""), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v;
    }),
  permissions: z.array(z.string()).min(1).optional(),
});

export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;
export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>;
