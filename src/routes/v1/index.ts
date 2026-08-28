import { Router } from "express";
import { getApiMeta } from "../../controllers/system.controller.js";
import { authRouter } from "./auth.routes.js";
import { billingRouter } from "./billing.routes.js";
import { invitesRouter } from "./invites.routes.js";
import { organizationsRouter } from "./organizations.routes.js";

/**
 * Versioned API root.
 * Pattern: routes/v1 → controllers → services → models
 */
export const v1Router = Router();

v1Router.get("/", getApiMeta);
v1Router.use("/auth", authRouter);
v1Router.use("/organizations", organizationsRouter);
v1Router.use("/invites", invitesRouter);
v1Router.use("/billing", billingRouter);
