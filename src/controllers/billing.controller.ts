import type { Request, Response } from "express";
import type { BillingInterval, PaidPlanSlug } from "../lib/subscriptionPlans.js";
import { AppError } from "../lib/errors/AppError.js";
import {
  captureCardCheckoutForUser,
  confirmPaddleCheckoutForUser,
  createCardCheckoutOrderForUser,
  createCheckoutSessionForUser,
  createPaddleCheckoutForUser,
  getBillingOverviewForUser,
  getPaddleCheckoutConfig,
  getPaypalCardClientToken,
  getPaypalCardSdkConfig,
  handlePaddleWebhook,
  handlePaypalWebhook,
  verifyPaddleWebhookRequest,
  verifyPaypalWebhookRequest,
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
    planSlug: PaidPlanSlug;
    interval: BillingInterval;
  };
  const result = await createCheckoutSessionForUser(
    requireUserId(req),
    planSlug,
    interval,
  );
  res.status(200).json(result);
}

export async function paypalCardConfig(req: Request, res: Response) {
  requireUserId(req);
  res.status(200).json(getPaypalCardSdkConfig());
}

export async function paypalCardClientToken(req: Request, res: Response) {
  requireUserId(req);
  const result = await getPaypalCardClientToken();
  res.status(200).json(result);
}

export async function createCardOrder(req: Request, res: Response) {
  const { planSlug, interval } = req.body as {
    planSlug: PaidPlanSlug;
    interval: BillingInterval;
  };
  const result = await createCardCheckoutOrderForUser(
    requireUserId(req),
    planSlug,
    interval,
  );
  res.status(200).json(result);
}

export async function captureCardOrder(req: Request, res: Response) {
  const { orderId } = req.body as { orderId: string };
  const billing = await captureCardCheckoutForUser(
    requireUserId(req),
    orderId,
  );
  res.status(200).json({ billing });
}

export async function paddleCardConfig(_req: Request, res: Response) {
  res.status(200).json(getPaddleCheckoutConfig());
}

export async function createPaddleCheckout(req: Request, res: Response) {
  const { planSlug, interval } = req.body as {
    planSlug: PaidPlanSlug;
    interval: BillingInterval;
  };
  const result = await createPaddleCheckoutForUser(
    requireUserId(req),
    planSlug,
    interval,
  );
  res.status(200).json(result);
}

export async function confirmPaddleCheckout(req: Request, res: Response) {
  const { transactionId } = req.body as { transactionId: string };
  const billing = await confirmPaddleCheckoutForUser(
    requireUserId(req),
    transactionId,
  );
  res.status(200).json({ billing });
}

export async function paddleWebhook(req: Request, res: Response) {
  const raw =
    (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ??
    JSON.stringify(req.body);
  const ok = verifyPaddleWebhookRequest(
    req.get("paddle-signature") ?? undefined,
    raw,
  );
  if (!ok) {
    throw new AppError(401, "Invalid Paddle webhook signature", {
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  }
  const result = await handlePaddleWebhook(req.body);
  res.status(200).json(result);
}

export async function paypalWebhook(req: Request, res: Response) {
  const ok = await verifyPaypalWebhookRequest(
    {
      transmissionId: req.get("paypal-transmission-id") ?? undefined,
      transmissionTime: req.get("paypal-transmission-time") ?? undefined,
      certUrl: req.get("paypal-cert-url") ?? undefined,
      authAlgo: req.get("paypal-auth-algo") ?? undefined,
      transmissionSig: req.get("paypal-transmission-sig") ?? undefined,
    },
    req.body,
  );

  if (!ok) {
    throw new AppError(401, "Invalid PayPal webhook signature", {
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  }

  const result = await handlePaypalWebhook(req.body);
  res.status(200).json(result);
}
