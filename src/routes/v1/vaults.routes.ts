import { Router } from "express";
import * as vaultController from "../../controllers/vault.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";
import { validateBody } from "../../middleware/validateBody.js";
import {
  createVaultBodySchema,
  updateVaultBodySchema,
} from "../../schemas/vault.schemas.js";

/**
 * Vaults under /api/v1/organizations/current/vaults
 * Parent router already applies requireFullAuth + email verified.
 */
export const vaultsRouter = Router({ mergeParams: true });

vaultsRouter.use(requireMembership, requireActiveSubscription);

vaultsRouter.get(
  "/",
  requirePermission("vault.read"),
  asyncHandler(vaultController.list),
);

vaultsRouter.post(
  "/",
  requirePermission("vault.create"),
  validateBody(createVaultBodySchema),
  asyncHandler(vaultController.create),
);

vaultsRouter.get(
  "/:vaultId",
  requirePermission("vault.read"),
  asyncHandler(vaultController.getOne),
);

vaultsRouter.patch(
  "/:vaultId",
  requirePermission("vault.update"),
  validateBody(updateVaultBodySchema),
  asyncHandler(vaultController.update),
);

vaultsRouter.delete(
  "/:vaultId",
  requirePermission("vault.delete"),
  asyncHandler(vaultController.remove),
);
