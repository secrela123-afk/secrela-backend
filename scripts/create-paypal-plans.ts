/**
 * Create Secrela catalog product + 4 ACTIVE billing plans on the
 * PayPal account that owns PAYPAL_CLIENT_ID (sandbox or live from env).
 */
import { env } from "../src/config/env.js";
import { PLAN_PRICES_USD_CENTS } from "../src/lib/subscriptionPlans.js";

type PaypalError = {
  name?: string;
  message?: string;
  details?: Array<{ issue?: string; description?: string }>;
};

async function paypalJson<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T & PaypalError }> {
  const base =
    env.paypal.mode === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as T & PaypalError;
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${json.name ?? ""} ${json.message ?? ""} ${JSON.stringify(json.details ?? [])}`,
    );
  }
  return { status: res.status, json };
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function main() {
  const base =
    env.paypal.mode === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  const auth = Buffer.from(
    `${env.paypal.clientId}:${env.paypal.clientSecret}`,
    "utf8",
  ).toString("base64");
  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`OAuth failed ${tokenRes.status}`);
  }
  const token = tokenJson.access_token;

  const product = await paypalJson<{ id: string }>(
    token,
    "POST",
    "/v1/catalogs/products",
    {
      name: "Secrela",
      description: "Secure company secrets and access management",
      type: "SERVICE",
      category: "SOFTWARE",
    },
  );
  const productId = product.json.id;
  console.log(`[paypal-setup] product ${productId}`);

  async function createPlan(
    name: string,
    intervalUnit: "MONTH" | "YEAR",
    value: string,
  ): Promise<string> {
    const created = await paypalJson<{ id: string; status?: string }>(
      token,
      "POST",
      "/v1/billing/plans",
      {
        product_id: productId,
        name,
        description: name,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: intervalUnit, interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value, currency_code: "USD" },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 3,
        },
      },
    );
    console.log(
      `[paypal-setup] ${name} ${created.json.id} ${created.json.status ?? ""}`,
    );
    return created.json.id;
  }

  const starterMonthly = await createPlan(
    "Starter Monthly",
    "MONTH",
    money(PLAN_PRICES_USD_CENTS.starter.monthly),
  );
  const starterYearly = await createPlan(
    "Starter Yearly",
    "YEAR",
    money(PLAN_PRICES_USD_CENTS.starter.yearlyTotal),
  );
  const teamMonthly = await createPlan(
    "Team Monthly",
    "MONTH",
    money(PLAN_PRICES_USD_CENTS.team.monthly),
  );
  const teamYearly = await createPlan(
    "Team Yearly",
    "YEAR",
    money(PLAN_PRICES_USD_CENTS.team.yearlyTotal),
  );
  const businessMonthly = await createPlan(
    "Business Monthly",
    "MONTH",
    money(PLAN_PRICES_USD_CENTS.business.monthly),
  );
  const businessYearly = await createPlan(
    "Business Yearly",
    "YEAR",
    money(PLAN_PRICES_USD_CENTS.business.yearlyTotal),
  );

  console.log("PAYPAL_PLAN_STARTER_MONTHLY=" + starterMonthly);
  console.log("PAYPAL_PLAN_STARTER_YEARLY=" + starterYearly);
  console.log("PAYPAL_PLAN_TEAM_MONTHLY=" + teamMonthly);
  console.log("PAYPAL_PLAN_TEAM_YEARLY=" + teamYearly);
  console.log("PAYPAL_PLAN_BUSINESS_MONTHLY=" + businessMonthly);
  console.log("PAYPAL_PLAN_BUSINESS_YEARLY=" + businessYearly);
}

main().catch((err) => {
  console.error("[paypal-setup] failed:", err);
  process.exit(1);
});
