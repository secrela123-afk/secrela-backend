import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import {
  createCheckoutSessionForUser,
  getBillingOverviewForUser,
  handleLemonWebhook,
  verifyLemonWebhookSignature,
} from "../services/billing.service.js";

function requireUserId(req: Request): string {
  const id = req.authUser?.id;
  if (!id) {
    throw new AppError(401, "Authentication required", { code: "UNAUTHORIZED" });
  }
  return id;
}

export async function billingOverview(req: Request, res: Response) {
  const billing = await getBillingOverviewForUser(requireUserId(req));
  res.status(200).json({ billing });
}

export async function createCheckout(req: Request, res: Response) {
  const { planSlug, interval } = req.body as {
    planSlug: "starter" | "team";
    interval: "monthly" | "yearly";
  };
  const result = await createCheckoutSessionForUser(
    requireUserId(req),
    planSlug,
    interval,
  );
  res.status(200).json(result);
}

export async function lemonWebhook(req: Request, res: Response) {
  const raw =
    (req as Request & { rawBody?: Buffer }).rawBody ??
    Buffer.from(JSON.stringify(req.body ?? {}));
  const signature = req.get("x-signature") ?? undefined;

  if (!verifyLemonWebhookSignature(raw, signature)) {
    throw new AppError(401, "Invalid Lemon Squeezy webhook signature", {
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  }

  const result = await handleLemonWebhook(req.body);
  res.status(200).json(result);
}
