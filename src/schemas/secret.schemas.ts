import { z } from "zod";
import {
  SECRET_RISK_LEVELS,
  SECRET_TYPES,
} from "../models/Secret.model.js";

export const createSecretBodySchema = z.object({
  vaultId: z.string().min(1, "Vault is required"),
  name: z.string().trim().min(2, "Secret name is too short").max(160),
  description: z.string().trim().max(500).optional().default(""),
  type: z.enum(SECRET_TYPES),
  riskLevel: z.enum(SECRET_RISK_LEVELS).optional().default("unknown"),
  /** Plaintext accepted once over HTTPS; never stored or logged. */
  value: z.string().min(1, "Secret value is required").max(16_384),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const updateSecretBodySchema = z
  .object({
    vaultId: z.string().min(1).optional(),
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(500).optional(),
    type: z.enum(SECRET_TYPES).optional(),
    riskLevel: z.enum(SECRET_RISK_LEVELS).optional(),
    value: z.string().min(1).max(16_384).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    { message: "At least one field is required" },
  );

export type CreateSecretBody = z.infer<typeof createSecretBodySchema>;
export type UpdateSecretBody = z.infer<typeof updateSecretBodySchema>;
