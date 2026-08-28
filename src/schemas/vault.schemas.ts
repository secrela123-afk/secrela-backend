import { z } from "zod";
import { VAULT_RISK_LEVELS } from "../models/Vault.model.js";

export const createVaultBodySchema = z.object({
  name: z.string().trim().min(2, "Vault name is too short").max(120),
  description: z.string().trim().max(500).optional().default(""),
  /** Icon color is assigned server-side in rotation — clients do not pick it. */
  riskLevel: z.enum(VAULT_RISK_LEVELS).optional().default("unknown"),
});

export const updateVaultBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  riskLevel: z.enum(VAULT_RISK_LEVELS).optional(),
});

export type CreateVaultBody = z.infer<typeof createVaultBodySchema>;
export type UpdateVaultBody = z.infer<typeof updateVaultBodySchema>;
