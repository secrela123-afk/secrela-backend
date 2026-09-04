/**
 * PayPal REST client (Subscriptions v1).
 * Sandbox: https://api-m.sandbox.paypal.com
 * Live:    https://api-m.paypal.com
 *
 * Lemon Squeezy is no longer used for checkout. See lemonSqueezy.ts (disabled).
 */
import { env } from "../config/env.js";
import { AppError } from "./errors/AppError.js";
import type { BillingInterval, PaidPlanSlug } from "./subscriptionPlans.js";

type PaypalLink = { href: string; rel: string; method?: string };

type PaypalSubscriptionCreateResponse = {
  id: string;
  status?: string;
  links?: PaypalLink[];
};

export type PaypalSubscription = {
  id: string;
  status?: string;
  plan_id?: string;
  custom_id?: string;
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { amount?: { value?: string; currency_code?: string } };
  };
  subscriber?: { email_address?: string; payer_id?: string };
};

type PaypalVerifyResponse = { verification_status?: string };

function apiBase(): string {
  return env.paypal.mode === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function requireConfigured(): void {
  if (!env.paypal.configured) {
    throw new AppError(
      503,
      "PayPal is not configured. Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and the four PAYPAL_PLAN_* ids.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
}

let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

async function getAccessToken(): Promise<string> {
  requireConfigured();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + 30_000) {
    return cachedToken.accessToken;
  }

  const auth = Buffer.from(
    `${env.paypal.clientId}:${env.paypal.clientSecret}`,
    "utf8",
  ).toString("base64");

  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!res.ok || !json.access_token) {
    throw new AppError(
      502,
      "PayPal authentication failed. Check CLIENT_ID / SECRET and sandbox vs live.",
      { code: "PAYPAL_AUTH_ERROR" },
    );
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAtMs: now + (json.expires_in ?? 300) * 1000,
  };
  return cachedToken.accessToken;
}

async function paypalRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json: T = {} as T;
  if (text) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      /* empty */
    }
  }

  if (!res.ok) {
    const paypalBody = json as {
      name?: string;
      message?: string;
      details?: Array<{ issue?: string; description?: string }>;
    };
    const issue = paypalBody.details?.[0]?.issue ?? paypalBody.name ?? "";
    const hint =
      res.status === 404 || issue === "RESOURCE_NOT_FOUND"
        ? " Plan IDs are not visible to this Client ID. Copy Sandbox Client ID + Secret from the same PayPal app/account that created the plans."
        : "";
    console.error(
      `[paypal] ${method} ${path} → ${res.status} ${paypalBody.name ?? ""} ${paypalBody.message ?? ""}`,
    );
    throw new AppError(
      502,
      `PayPal request failed (${res.status}${issue ? `: ${issue}` : ""}).${hint}`,
      { code: "PAYPAL_API_ERROR" },
    );
  }

  return json;
}

export function paypalPlanIdFor(
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): string {
  const p = env.paypal.plans;
  const byPlan = {
    starter: { monthly: p.starterMonthly, yearly: p.starterYearly },
    team: { monthly: p.teamMonthly, yearly: p.teamYearly },
    business: { monthly: p.businessMonthly, yearly: p.businessYearly },
  } as const;
  return byPlan[planSlug][interval];
}

export function encodePaypalCustomId(
  organizationId: string,
  planSlug: string,
  interval: string,
): string {
  return `${organizationId}|${planSlug}|${interval}`;
}

export function decodePaypalCustomId(customId: string | undefined): {
  organizationId: string;
  planSlug: string;
  interval: string;
} | null {
  if (!customId) return null;
  const [organizationId, planSlug, interval] = customId.split("|");
  if (!organizationId || !planSlug || !interval) return null;
  return { organizationId, planSlug, interval };
}

export async function createPaypalSubscription(input: {
  planId: string;
  customId: string;
  returnUrl: string;
  cancelUrl: string;
  brandName: string;
}): Promise<{ approveUrl: string; subscriptionId: string }> {
  const created = await paypalRequest<PaypalSubscriptionCreateResponse>(
    "POST",
    "/v1/billing/subscriptions",
    {
      plan_id: input.planId,
      custom_id: input.customId,
        application_context: {
          brand_name: input.brandName,
          locale: "en-US",
          landing_page: "BILLING",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
    },
  );

  const approveUrl =
    created.links?.find((l) => l.rel === "approve")?.href ?? "";
  if (!approveUrl || !created.id) {
    throw new AppError(502, "PayPal did not return an approval URL", {
      code: "PAYPAL_CHECKOUT_MISSING",
    });
  }

  return { approveUrl, subscriptionId: created.id };
}

export async function getPaypalSubscription(
  subscriptionId: string,
): Promise<PaypalSubscription> {
  return paypalRequest<PaypalSubscription>(
    "GET",
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export async function suspendPaypalSubscription(
  subscriptionId: string,
): Promise<void> {
  await paypalRequest("POST", `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/suspend`, {
    reason: "Customer turned off auto-renew in Secrela",
  });
}

export async function activatePaypalSubscription(
  subscriptionId: string,
): Promise<void> {
  await paypalRequest("POST", `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/activate`, {
    reason: "Customer turned on auto-renew in Secrela",
  });
}

export function paypalPublicClientId(): string {
  requireConfigured();
  return env.paypal.clientId;
}

export function paypalMode(): "sandbox" | "live" {
  return env.paypal.mode;
}

export async function generatePaypalClientToken(): Promise<string> {
  requireConfigured();
  const json = await paypalRequest<{ client_token?: string }>(
    "POST",
    "/v1/identity/generate-token",
    {},
  );
  if (!json.client_token) {
    throw new AppError(502, "PayPal did not return a client token", {
      code: "PAYPAL_CLIENT_TOKEN_MISSING",
    });
  }
  return json.client_token;
}

export type PaypalCaptureOrder = {
  id: string;
  status?: string;
  purchase_units?: Array<{
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        amount?: { value?: string; currency_code?: string };
      }>;
    };
  }>;
  payment_source?: {
    card?: { brand?: string; last_digits?: string };
  };
};

export async function createPaypalCaptureOrder(input: {
  customId: string;
  description: string;
  value: string;
  currency: string;
}): Promise<{ orderId: string }> {
  requireConfigured();
  const created = await paypalRequest<PaypalCaptureOrder>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: input.customId,
          description: input.description.slice(0, 127),
          amount: {
            currency_code: input.currency,
            value: input.value,
          },
        },
      ],
    },
    { Prefer: "return=representation" },
  );
  if (!created.id) {
    throw new AppError(502, "PayPal did not return an order id", {
      code: "PAYPAL_ORDER_MISSING",
    });
  }
  return { orderId: created.id };
}

export async function capturePaypalOrder(
  orderId: string,
): Promise<PaypalCaptureOrder> {
  requireConfigured();
  return paypalRequest<PaypalCaptureOrder>(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {},
    { Prefer: "return=representation" },
  );
}

export async function verifyPaypalWebhook(input: {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
  webhookEvent: unknown;
}): Promise<boolean> {
  if (!env.paypal.webhookId) {
    return env.nodeEnv !== "production";
  }

  const result = await paypalRequest<PaypalVerifyResponse>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    {
      transmission_id: input.transmissionId,
      transmission_time: input.transmissionTime,
      cert_url: input.certUrl,
      auth_algo: input.authAlgo,
      transmission_sig: input.transmissionSig,
      webhook_id: env.paypal.webhookId,
      webhook_event: input.webhookEvent,
    },
  );

  return result.verification_status === "SUCCESS";
}
