import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import {
  createLemonCheckout,
  lemonVariantIdFromAttributes,
  listLemonSubscriptions,
  planFromVariantId,
  updateLemonSubscription,
  variantIdForPlan,
  verifyLemonWebhookSignature,
} from "../lib/lemonSqueezy.js";
import {
  activatePaypalSubscription,
  capturePaypalOrder,
  createPaypalCaptureOrder,
  createPaypalSubscription,
  decodePaypalCustomId,
  encodePaypalCustomId,
  generatePaypalClientToken,
  getPaypalSubscription,
  paypalMode,
  paypalPlanIdFor,
  paypalPublicClientId,
  suspendPaypalSubscription,
  verifyPaypalWebhook,
} from "../lib/paypal.js";
import {
  createPaddleTransaction,
  getPaddleTransaction,
  paddleGrandTotalCents,
  paddlePriceIdFor,
  paddlePublicConfig,
  type PaddleTransaction,
  verifyPaddleWebhookSignature,
} from "../lib/paddle.js";
import {
  amountCentsForPlan,
  isPaidPlanSlug,
  planDisplayName,
  type BillingInterval,
  type PaidPlanSlug,
  type PlanSlug,
  type SubscriptionStatus,
} from "../lib/subscriptionPlans.js";
import { Organization } from "../models/Organization.model.js";
import type { OrganizationDocument } from "../models/Organization.model.js";
import { User } from "../models/User.model.js";
import { activateOrganizationSubscription } from "./subscription.service.js";
import { loadMembershipContext } from "./organization.service.js";

export type PaymentMethodDto = {
  brand: string;
  last4: string;
  isDefault: boolean;
  firstSeenAt: string;
  lastUsedAt: string;
};

export type BillingOverview = {
  lemonConfigured: boolean;
  paypalConfigured: boolean;
  paddleConfigured: boolean;
  planSlug: PlanSlug;
  planLabel: string;
  subscriptionStatus: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  subscriptionAmountCents: number | null;
  currency: string;
  autoRenew: boolean;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  paymentMethods: PaymentMethodDto[];
  updatePaymentUrl: string | null;
  customerPortalUrl: string | null;
  paypalSubscriptionId: string | null;
};

function toIso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString();
}

function paymentMethodsDto(org: OrganizationDocument): PaymentMethodDto[] {
  const list = org.paymentMethods ?? [];
  return list.map((pm) => ({
    brand: pm.brand,
    last4: pm.last4,
    isDefault: Boolean(pm.isDefault),
    firstSeenAt: toIso(pm.firstSeenAt as Date) ?? new Date().toISOString(),
    lastUsedAt: toIso(pm.lastUsedAt as Date) ?? new Date().toISOString(),
  }));
}

export function billingOverviewFromOrg(
  org: OrganizationDocument,
): BillingOverview {
  return {
    lemonConfigured: env.lemonSqueezy.configured,
    paypalConfigured: false,
    paddleConfigured: false,
    planSlug: (org.planSlug ?? "starter") as PlanSlug,
    planLabel: org.plan ?? planDisplayName((org.planSlug ?? "starter") as PlanSlug),
    subscriptionStatus: (org.subscriptionStatus ??
      "pending_payment") as SubscriptionStatus,
    billingInterval: (org.billingInterval ?? null) as BillingInterval | null,
    subscriptionAmountCents: org.subscriptionAmountCents ?? null,
    currency: org.currency ?? "USD",
    autoRenew: Boolean(org.autoRenew),
    trialEndsAt: toIso(org.trialEndsAt),
    currentPeriodEndsAt: toIso(org.currentPeriodEndsAt),
    cardBrand: org.cardBrand ?? null,
    cardLast4: org.cardLast4 ?? null,
    paymentMethods: paymentMethodsDto(org),
    updatePaymentUrl: org.lemonUpdatePaymentUrl ?? null,
    customerPortalUrl: org.lemonCustomerPortalUrl ?? null,
    paypalSubscriptionId: org.paypalSubscriptionId ?? null,
  };
}

export async function getBillingOverviewForUser(
  userId: string,
): Promise<BillingOverview> {
  const { membership } = await loadMembershipContext(userId);
  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  if (shouldPullLemonAfterCheckout(organization)) {
    return syncLemonSubscriptionForUser(userId);
  }
  return billingOverviewFromOrg(organization);
}

/**
 * Create a Lemon Squeezy hosted checkout URL for the org owner/admin.
 * Card details stay on Lemon (Merchant of Record). PayPal/Paddle are paused.
 */
export async function createCheckoutSessionForUser(
  userId: string,
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): Promise<{ checkoutUrl: string; mockActivated?: boolean }> {
  const { membership, resolved } = await loadMembershipContext(userId);

  if (resolved.systemKey !== "owner" && resolved.systemKey !== "admin") {
    throw new AppError(403, "Only owners or admins can start checkout", {
      code: "FORBIDDEN",
    });
  }

  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }

  const user = await User.findById(userId).select("email name").lean();
  if (!user) {
    throw new AppError(401, "User not found", { code: "UNAUTHORIZED" });
  }

  if (!env.lemonSqueezy.configured) {
    if (!env.lemonSqueezy.allowMockActivate) {
      throw new AppError(
        503,
        "Lemon Squeezy is not configured. Add LEMON_SQUEEZY_API_KEY, store id, and variant ids.",
        { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
      );
    }
    await activateOrganizationSubscription(organization, planSlug, interval);
    await Organization.findByIdAndUpdate(organization._id, {
      $set: { autoRenew: true, autoRenewInterval: interval },
    });
    return { checkoutUrl: `${env.appOrigin}/app/billing?mock=1`, mockActivated: true };
  }

  const variantId = variantIdForPlan(planSlug, interval);
  if (!variantId) {
    throw new AppError(
      503,
      `Missing Lemon Squeezy variant ID for ${planSlug}/${interval}. Set LEMON_SQUEEZY_VARIANT_* on the server.`,
      { code: "LEMON_VARIANT_MISSING" },
    );
  }

  const redirectUrl = `${env.appOrigin}/app/billing?checkout=success`;
  const { checkoutUrl, checkoutId } = await createLemonCheckout({
    variantId,
    email: user.email ?? "",
    name: user.name ?? "",
    custom: {
      organizationId: organization._id.toString(),
      planSlug: String(planSlug),
      interval: String(interval),
    },
    redirectUrl,
  });

  try {
    organization.pendingLemonCheckoutId = checkoutId;
    organization.pendingLemonPlanSlug = planSlug;
    organization.pendingLemonInterval = interval;
    await asMutableOrg(organization).save();
  } catch (err) {
    console.error("[securevault-api] failed to save pending Lemon checkout:", err);
    throw new AppError(
      500,
      "Checkout was created but could not be saved. Try again.",
      { code: "LEMON_CHECKOUT_SAVE_FAILED" },
    );
  }

  return { checkoutUrl };
}

async function requireOwnerOrAdmin(userId: string) {
  const { membership, resolved } = await loadMembershipContext(userId);
  if (resolved.systemKey !== "owner" && resolved.systemKey !== "admin") {
    throw new AppError(403, "Only owners or admins can start checkout", {
      code: "FORBIDDEN",
    });
  }
  const organization = await Organization.findById(membership.organizationId);
  if (!organization) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  return { membership, organization };
}

export function getPaypalCardSdkConfig(): {
  clientId: string;
  mode: "sandbox" | "live";
  currency: string;
} {
  if (!env.paypal.configured) {
    throw new AppError(
      503,
      "PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
  return {
    clientId: paypalPublicClientId(),
    mode: paypalMode(),
    currency: "USD",
  };
}

export async function getPaypalCardClientToken(): Promise<{
  clientToken: string;
}> {
  if (!env.paypal.configured) {
    throw new AppError(
      503,
      "PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
  const clientToken = await generatePaypalClientToken();
  return { clientToken };
}

function usdValueFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function createCardCheckoutOrderForUser(
  userId: string,
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): Promise<{ orderId: string; amount: string; currency: string }> {
  const { organization } = await requireOwnerOrAdmin(userId);

  if (!env.paypal.configured) {
    throw new AppError(
      503,
      "PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }

  const cents = amountCentsForPlan(planSlug, interval);
  if (cents == null) {
    throw new AppError(400, "This plan cannot be billed", {
      code: "INVALID_PLAN",
    });
  }

  const { orderId } = await createPaypalCaptureOrder({
    customId: encodePaypalCustomId(
      organization._id.toString(),
      planSlug,
      interval,
    ),
    description: `Secrela ${planDisplayName(planSlug)} ${interval}`,
    value: usdValueFromCents(cents),
    currency: "USD",
  });

  return { orderId, amount: usdValueFromCents(cents), currency: "USD" };
}

export async function captureCardCheckoutForUser(
  userId: string,
  orderId: string,
): Promise<BillingOverview> {
  const { organization } = await requireOwnerOrAdmin(userId);

  const captured = await capturePaypalOrder(orderId);
  const unit = captured.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const status = (capture?.status ?? captured.status ?? "").toUpperCase();
  if (status !== "COMPLETED" && captured.status !== "COMPLETED") {
    throw new AppError(402, "Card payment was not completed", {
      code: "PAYPAL_CAPTURE_INCOMPLETE",
    });
  }

  const decoded = decodePaypalCustomId(unit?.custom_id);
  if (
    !decoded ||
    decoded.organizationId !== organization._id.toString()
  ) {
    throw new AppError(403, "Payment does not match this workspace", {
      code: "PAYPAL_ORDER_MISMATCH",
    });
  }
  if (!isPaidPlanSlug(decoded.planSlug)) {
    throw new AppError(400, "Invalid paid plan on this order", {
      code: "INVALID_PLAN",
    });
  }
  if (decoded.interval !== "monthly" && decoded.interval !== "yearly") {
    throw new AppError(400, "Invalid billing interval on this order", {
      code: "INVALID_INTERVAL",
    });
  }

  const expectedCents = amountCentsForPlan(
    decoded.planSlug,
    decoded.interval,
  );
  const paidValue =
    capture?.amount?.value ?? unit?.amount?.value ?? "";
  if (
    expectedCents == null ||
    paidValue !== usdValueFromCents(expectedCents)
  ) {
    throw new AppError(402, "Paid amount does not match the selected plan", {
      code: "PAYPAL_AMOUNT_MISMATCH",
    });
  }

  await activateOrganizationSubscription(
    organization,
    decoded.planSlug,
    decoded.interval,
  );
  const fresh = await Organization.findById(organization._id);
  if (!fresh) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  fresh.autoRenew = false;
  upsertPaymentMethod(
    fresh,
    captured.payment_source?.card?.brand,
    captured.payment_source?.card?.last_digits,
  );
  await asMutableOrg(fresh).save();

  return billingOverviewFromOrg(fresh);
}

export function getPaddleCheckoutConfig() {
  return paddlePublicConfig();
}

export async function createPaddleCheckoutForUser(
  userId: string,
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): Promise<{ transactionId: string }> {
  const { organization } = await requireOwnerOrAdmin(userId);
  if (!env.paddle.configured) {
    throw new AppError(
      503,
      "Paddle is not configured. Add PADDLE_API_KEY, PADDLE_CLIENT_TOKEN, and PADDLE_PRICE_* ids.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
  const priceId = paddlePriceIdFor(planSlug, interval);
  if (!priceId) {
    throw new AppError(500, "Missing Paddle price ID for this plan", {
      code: "PADDLE_PRICE_MISSING",
    });
  }
  return createPaddleTransaction({
    priceId,
    organizationId: organization._id.toString(),
    planSlug,
    interval,
  });
}

async function activateFromPaddleTransaction(
  organization: OrganizationDocument,
  txn: PaddleTransaction,
): Promise<BillingOverview> {
  const custom = txn.custom_data ?? {};
  const organizationId = custom.organizationId ?? "";
  const planSlug = custom.planSlug;
  const interval = custom.interval;
  if (organizationId !== organization._id.toString()) {
    throw new AppError(403, "Payment does not match this workspace", {
      code: "PADDLE_TRANSACTION_MISMATCH",
    });
  }
  if (!isPaidPlanSlug(planSlug)) {
    throw new AppError(400, "Invalid paid plan on this transaction", {
      code: "INVALID_PLAN",
    });
  }
  if (interval !== "monthly" && interval !== "yearly") {
    throw new AppError(400, "Invalid billing interval on this transaction", {
      code: "INVALID_INTERVAL",
    });
  }
  const expectedCents = amountCentsForPlan(planSlug, interval);
  const paidCents = paddleGrandTotalCents(txn);
  const amountOk =
    expectedCents != null &&
    paidCents != null &&
    (paidCents === expectedCents || Math.round(paidCents * 100) === expectedCents);
  if (!amountOk) {
    throw new AppError(402, "Paid amount does not match the selected plan", {
      code: "PADDLE_AMOUNT_MISMATCH",
    });
  }
  const status = (txn.status ?? "").toLowerCase();
  if (status !== "completed" && status !== "paid" && status !== "billed") {
    throw new AppError(402, "Paddle payment was not completed", {
      code: "PADDLE_PAYMENT_INCOMPLETE",
    });
  }

  await activateOrganizationSubscription(organization, planSlug, interval);
  const fresh = await Organization.findById(organization._id);
  if (!fresh) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  fresh.autoRenew = false;
  const card = txn.payments?.[0]?.method_details?.card;
  upsertPaymentMethod(fresh, card?.type ?? "card", card?.last4);
  await asMutableOrg(fresh).save();
  return billingOverviewFromOrg(fresh);
}

export async function confirmPaddleCheckoutForUser(
  userId: string,
  transactionId: string,
): Promise<BillingOverview> {
  const { organization } = await requireOwnerOrAdmin(userId);
  const txn = await getPaddleTransaction(transactionId);
  return activateFromPaddleTransaction(organization, txn);
}

export function verifyPaddleWebhookRequest(
  signatureHeader: string | undefined,
  rawBody: string,
): boolean {
  return verifyPaddleWebhookSignature(rawBody, signatureHeader);
}

export async function handlePaddleWebhook(event: {
  event_type?: string;
  data?: PaddleTransaction;
}): Promise<{ received: true }> {
  const type = event.event_type ?? "";
  if (
    type !== "transaction.completed" &&
    type !== "transaction.paid" &&
    type !== "transaction.updated"
  ) {
    return { received: true };
  }
  const txn = event.data;
  if (!txn?.id) return { received: true };
  const organizationId = txn.custom_data?.organizationId;
  if (!organizationId) return { received: true };
  const org = await Organization.findById(organizationId);
  if (!org) return { received: true };
  const status = (txn.status ?? "").toLowerCase();
  if (status !== "completed" && status !== "paid" && status !== "billed") {
    return { received: true };
  }
  try {
    await activateFromPaddleTransaction(org, txn);
  } catch {
    // Signature already verified; ignore amount/status races from duplicate events.
  }
  return { received: true };
}

/** Plain card row — InferSchemaType marks paymentMethods as DocumentArray. */
type StoredCard = {
  brand: string;
  last4: string;
  isDefault: boolean;
  firstSeenAt: Date;
  lastUsedAt: Date;
};

type OrgMutable = Omit<OrganizationDocument, "paymentMethods"> & {
  save: () => Promise<OrganizationDocument>;
  paymentMethods: StoredCard[];
  cardBrand: string | null;
  cardLast4: string | null;
};

function asMutableOrg(org: OrganizationDocument): OrgMutable {
  return org as unknown as OrgMutable;
}

function upsertPaymentMethod(
  org: OrganizationDocument,
  brand: string | null | undefined,
  last4: string | null | undefined,
): void {
  if (!brand || !last4 || last4.length !== 4) return;

  const mutable = asMutableOrg(org);
  const methods: StoredCard[] = (mutable.paymentMethods ?? []).map((m) => ({
    brand: m.brand,
    last4: m.last4,
    isDefault: Boolean(m.isDefault),
    firstSeenAt: new Date(m.firstSeenAt),
    lastUsedAt: new Date(m.lastUsedAt),
  }));

  const idx = methods.findIndex(
    (m) => m.brand === brand && m.last4 === last4,
  );
  const now = new Date();

  if (idx >= 0) {
    const current = methods[idx]!;
    methods[idx] = {
      ...current,
      lastUsedAt: now,
      isDefault: true,
    };
  } else {
    methods.push({
      brand,
      last4,
      isDefault: true,
      firstSeenAt: now,
      lastUsedAt: now,
    });
  }

  for (let i = 0; i < methods.length; i++) {
    const row = methods[i]!;
    if (!(row.brand === brand && row.last4 === last4)) {
      methods[i] = { ...row, isDefault: false };
    }
  }

  // Keep last 8 cards for display history.
  mutable.paymentMethods = methods.slice(-8);
  mutable.cardBrand = brand;
  mutable.cardLast4 = last4;
}

function mapPaypalStatus(paypalStatus: string): SubscriptionStatus {
  switch (paypalStatus.toUpperCase()) {
    case "APPROVAL_PENDING":
      return "pending_payment";
    case "APPROVED":
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "pending_payment";
    case "CANCELLED":
    case "EXPIRED":
      return "expired";
    default:
      return "pending_payment";
  }
}

export type PaypalWebhookEvent = {
  event_type?: string;
  resource?: {
    id?: string;
    custom_id?: string;
    status?: string;
    billing_info?: { next_billing_time?: string };
  };
};

export async function verifyPaypalWebhookRequest(
  headers: {
    transmissionId?: string;
    transmissionTime?: string;
    certUrl?: string;
    authAlgo?: string;
    transmissionSig?: string;
  },
  event: unknown,
): Promise<boolean> {
  if (
    !headers.transmissionId ||
    !headers.transmissionTime ||
    !headers.certUrl ||
    !headers.authAlgo ||
    !headers.transmissionSig
  ) {
    return env.nodeEnv !== "production" && !env.paypal.webhookId;
  }

  return verifyPaypalWebhook({
    transmissionId: headers.transmissionId,
    transmissionTime: headers.transmissionTime,
    certUrl: headers.certUrl,
    authAlgo: headers.authAlgo,
    transmissionSig: headers.transmissionSig,
    webhookEvent: event,
  });
}

async function applyPaypalSubscriptionToOrg(
  org: OrganizationDocument,
  subscription: {
    id: string;
    status?: string;
    custom_id?: string;
    billing_info?: { next_billing_time?: string };
  },
): Promise<void> {
  const decoded = decodePaypalCustomId(subscription.custom_id);
  const planSlug = (decoded?.planSlug ?? org.planSlug ?? "starter") as PlanSlug;
  const interval = (decoded?.interval ??
    org.billingInterval ??
    "monthly") as BillingInterval;
  const paypalStatus = String(subscription.status ?? "ACTIVE");
  const status = mapPaypalStatus(paypalStatus);
  const nextBilling = subscription.billing_info?.next_billing_time
    ? new Date(subscription.billing_info.next_billing_time)
    : null;

  upsertPaymentMethod(org, "PayPal", "0000");

  org.paypalSubscriptionId = subscription.id;
  org.planSlug = planSlug === "free" ? "starter" : planSlug;
  org.plan = planDisplayName(org.planSlug as PlanSlug);
  org.billingInterval = interval;
  org.subscriptionAmountCents = amountCentsForPlan(
    org.planSlug as PlanSlug,
    interval,
  );
  org.currency = "USD";
  org.subscriptionStatus = status;
  org.autoRenew = paypalStatus === "ACTIVE";
  org.autoRenewInterval = org.autoRenew ? interval : null;
  org.currentPeriodEndsAt = nextBilling;
  org.lemonCustomerPortalUrl = "https://www.paypal.com/myaccount/autopay/";
  org.lemonUpdatePaymentUrl = org.lemonCustomerPortalUrl;
  org.lastExpiryReminderDays = null;
  org.lastExpiryReminderAt = null;

  await asMutableOrg(org).save();
}

export async function handlePaypalWebhook(
  payload: PaypalWebhookEvent,
): Promise<{ ok: true; event: string }> {
  const event = payload.event_type ?? "unknown";
  const resourceId = payload.resource?.id ?? "";
  if (!resourceId) {
    return { ok: true, event };
  }

  let org = await Organization.findOne({ paypalSubscriptionId: resourceId });
  const decoded = decodePaypalCustomId(payload.resource?.custom_id);
  if (!org && decoded?.organizationId) {
    org = await Organization.findById(decoded.organizationId);
  }

  if (
    event === "BILLING.SUBSCRIPTION.ACTIVATED" ||
    event === "BILLING.SUBSCRIPTION.UPDATED"
  ) {
    const subscription = await getPaypalSubscription(resourceId);
    if (!org) {
      return { ok: true, event };
    }
    await applyPaypalSubscriptionToOrg(org, subscription);
    return { ok: true, event };
  }

  if (event === "PAYMENT.SALE.COMPLETED" && org) {
    org.subscriptionStatus = "active";
    org.autoRenew = true;
    await asMutableOrg(org).save();
    return { ok: true, event };
  }

  if (
    event === "BILLING.SUBSCRIPTION.SUSPENDED" ||
    event === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
  ) {
    if (org) {
      org.subscriptionStatus = "pending_payment";
      await asMutableOrg(org).save();
    }
    return { ok: true, event };
  }

  if (
    event === "BILLING.SUBSCRIPTION.CANCELLED" ||
    event === "BILLING.SUBSCRIPTION.EXPIRED"
  ) {
    if (org) {
      org.subscriptionStatus = "expired";
      org.autoRenew = false;
      await asMutableOrg(org).save();
    }
    return { ok: true, event };
  }

  return { ok: true, event };
}

export async function syncAutoRenewToPaypal(
  org: OrganizationDocument,
  autoRenew: boolean,
): Promise<void> {
  if (!env.paypal.configured || !org.paypalSubscriptionId) {
    return;
  }

  if (!autoRenew) {
    await suspendPaypalSubscription(org.paypalSubscriptionId);
  } else {
    await activatePaypalSubscription(org.paypalSubscriptionId);
  }
}

/** Pause / resume Lemon subscription when the owner toggles auto-renew. */
export async function syncAutoRenewToLemon(
  org: OrganizationDocument,
  autoRenew: boolean,
): Promise<void> {
  if (!env.lemonSqueezy.configured || !org.lemonSubscriptionId) {
    return;
  }
  if (!autoRenew) {
    await updateLemonSubscription(org.lemonSubscriptionId, {
      pause: { mode: "void" },
    });
    return;
  }
  await updateLemonSubscription(org.lemonSubscriptionId, { pause: null });
}

export function verifyLemonWebhookRequest(
  signatureHeader: string | undefined,
  rawBody: string,
): boolean {
  return verifyLemonWebhookSignature(rawBody, signatureHeader);
}

type LemonWebhookBody = {
  meta?: {
    event_name?: string;
    custom_data?: {
      organizationId?: string;
      planSlug?: string;
      interval?: string;
    };
  };
  data?: {
    id?: string;
    type?: string;
    attributes?: Record<string, unknown> & {
      status?: string;
      customer_id?: number | string;
      order_id?: number | string;
      card_brand?: string | null;
      card_last_four?: string | null;
      renews_at?: string | null;
      urls?: {
        update_payment_method?: string;
        customer_portal?: string;
      };
    };
  };
};

function mapLemonStatus(raw: string): SubscriptionStatus {
  switch (raw) {
    case "on_trial":
      return "trialing";
    case "active":
    case "paid":
      return "active";
    case "paused":
    case "past_due":
    case "unpaid":
      return "pending_payment";
    case "cancelled":
    case "expired":
      return "expired";
    default:
      return "active";
  }
}

function shouldPullLemonAfterCheckout(org: OrganizationDocument): boolean {
  if (!env.lemonSqueezy.configured) return false;
  if (
    org.subscriptionStatus === "active" &&
    isPaidPlanSlug(String(org.planSlug ?? ""))
  ) {
    return false;
  }
  return (
    org.subscriptionStatus === "trialing" ||
    org.planSlug === "free" ||
    Boolean(org.pendingLemonPlanSlug)
  );
}

function resolvePaidPlan(
  custom: { planSlug?: string; interval?: string },
  attrs: Record<string, unknown>,
  fallbackOrg?: OrganizationDocument,
): { planSlug: PaidPlanSlug; interval: BillingInterval } | null {
  const fromVariant = planFromVariantId(lemonVariantIdFromAttributes(attrs));
  const pendingSlug = String(fallbackOrg?.pendingLemonPlanSlug ?? "");
  const planSlug = isPaidPlanSlug(custom.planSlug)
    ? custom.planSlug
    : isPaidPlanSlug(pendingSlug)
      ? pendingSlug
      : fromVariant?.planSlug;
  const pendingInterval = fallbackOrg?.pendingLemonInterval;
  const interval =
    custom.interval === "monthly" || custom.interval === "yearly"
      ? custom.interval
      : pendingInterval === "monthly" || pendingInterval === "yearly"
        ? pendingInterval
        : fromVariant?.interval;
  if (!planSlug || !interval) return null;
  return { planSlug, interval };
}

async function applyLemonPurchaseToOrg(
  org: OrganizationDocument,
  patch: {
    planSlug?: PaidPlanSlug;
    interval?: BillingInterval;
    subscriptionId?: string;
    orderId?: string;
    customerId?: string;
    status?: string;
    cardBrand?: string | null;
    cardLast4?: string | null;
    updatePaymentUrl?: string;
    customerPortalUrl?: string;
    renewsAt?: string | null;
  },
): Promise<OrganizationDocument> {
  if (patch.planSlug && patch.interval) {
    await activateOrganizationSubscription(org, patch.planSlug, patch.interval);
  }
  const fresh = await Organization.findById(org._id);
  if (!fresh) {
    throw new AppError(404, "Organization no longer exists", {
      code: "ORGANIZATION_NOT_FOUND",
    });
  }
  if (patch.subscriptionId) fresh.lemonSubscriptionId = patch.subscriptionId;
  if (patch.orderId) fresh.lemonOrderId = patch.orderId;
  if (patch.customerId) fresh.lemonCustomerId = patch.customerId;
  fresh.pendingLemonCheckoutId = null;
  fresh.pendingLemonPlanSlug = null;
  fresh.pendingLemonInterval = null;
  if (patch.status) {
    fresh.autoRenew = patch.status === "active" || patch.status === "on_trial";
    if (patch.planSlug) {
      fresh.subscriptionStatus = mapLemonStatus(patch.status);
    }
  } else if (patch.planSlug) {
    fresh.autoRenew = true;
  }
  upsertPaymentMethod(fresh, patch.cardBrand, patch.cardLast4);
  if (patch.updatePaymentUrl) {
    fresh.lemonUpdatePaymentUrl = patch.updatePaymentUrl;
  }
  if (patch.customerPortalUrl) {
    fresh.lemonCustomerPortalUrl = patch.customerPortalUrl;
  }
  if (patch.renewsAt) {
    const renews = new Date(patch.renewsAt);
    if (!Number.isNaN(renews.getTime())) fresh.currentPeriodEndsAt = renews;
  }
  await asMutableOrg(fresh).save();
  return fresh;
}

const lemonSyncInFlight = new Map<string, Promise<BillingOverview>>();

function lemonUrls(attrs: Record<string, unknown>): {
  updatePaymentUrl?: string;
  customerPortalUrl?: string;
} {
  const urls = attrs.urls;
  if (!urls || typeof urls !== "object") return {};
  const u = urls as {
    update_payment_method?: string;
    customer_portal?: string;
  };
  return {
    updatePaymentUrl: u.update_payment_method,
    customerPortalUrl: u.customer_portal,
  };
}

/**
 * After Lemon hosted checkout, webhooks often never reach localhost
 * (and custom_data can be missing). Pull the subscription from Lemon by email.
 */
export async function syncLemonSubscriptionForUser(
  userId: string,
): Promise<BillingOverview> {
  const { membership } = await loadMembershipContext(userId);
  const orgId = membership.organizationId.toString();
  const existing = lemonSyncInFlight.get(orgId);
  if (existing) return existing;

  const run = (async () => {
    const organization = await Organization.findById(membership.organizationId);
    if (!organization) {
      throw new AppError(404, "Organization no longer exists", {
        code: "ORGANIZATION_NOT_FOUND",
      });
    }
    if (
      organization.subscriptionStatus === "active" &&
      isPaidPlanSlug(String(organization.planSlug ?? "")) &&
      organization.lemonSubscriptionId
    ) {
      return billingOverviewFromOrg(organization);
    }
    if (!env.lemonSqueezy.configured) {
      return billingOverviewFromOrg(organization);
    }

    const user = await User.findById(userId).select("email").lean();
    if (!user?.email) {
      return billingOverviewFromOrg(organization);
    }
    const subs = await listLemonSubscriptions({
      email: user.email,
    });
    const usable = subs.filter((sub) => {
      const status = String(sub.attributes.status ?? "");
      return (
        status === "active" ||
        status === "on_trial" ||
        status === "past_due" ||
        status === "paid"
      );
    });

    const pendingVariant =
      organization.pendingLemonPlanSlug && organization.pendingLemonInterval
        ? variantIdForPlan(
            organization.pendingLemonPlanSlug as PaidPlanSlug,
            organization.pendingLemonInterval as BillingInterval,
          )
        : "";
    const chosen =
      usable.find((sub) => {
        const vid = lemonVariantIdFromAttributes(sub.attributes);
        return Boolean(pendingVariant) && vid === pendingVariant;
      }) ?? usable[0];

    if (!chosen) {
      return billingOverviewFromOrg(organization);
    }

    const attrs = chosen.attributes;
    const resolved = resolvePaidPlan(
      {
        planSlug: organization.pendingLemonPlanSlug ?? undefined,
        interval: organization.pendingLemonInterval ?? undefined,
      },
      attrs,
      organization,
    );
    const updated = await applyLemonPurchaseToOrg(organization, {
      planSlug: resolved?.planSlug,
      interval: resolved?.interval,
      subscriptionId: chosen.id,
      orderId: attrs.order_id != null ? String(attrs.order_id) : undefined,
      customerId:
        attrs.customer_id != null ? String(attrs.customer_id) : undefined,
      status: String(attrs.status ?? "active"),
      cardBrand: attrs.card_brand != null ? String(attrs.card_brand) : null,
      cardLast4:
        attrs.card_last_four != null ? String(attrs.card_last_four) : null,
      renewsAt: attrs.renews_at != null ? String(attrs.renews_at) : null,
      ...lemonUrls(attrs),
    });
    return billingOverviewFromOrg(updated);
  })().finally(() => {
    lemonSyncInFlight.delete(orgId);
  });

  lemonSyncInFlight.set(orgId, run);
  return run;
}

export async function handleLemonWebhook(
  event: LemonWebhookBody,
): Promise<{ received: true }> {
  const type = event.meta?.event_name ?? "";
  const custom = event.meta?.custom_data ?? {};
  const dataId = event.data?.id ?? "";
  const dataType = event.data?.type ?? "";
  const attrs = event.data?.attributes ?? {};
  const isOrder = type === "order_created" || dataType === "orders";
  const subscriptionId = isOrder ? "" : dataId;
  const orderId = isOrder
    ? dataId
    : attrs.order_id != null
      ? String(attrs.order_id)
      : "";

  let org: OrganizationDocument | null = null;
  if (custom.organizationId) {
    org = await Organization.findById(custom.organizationId);
  }
  if (!org && subscriptionId) {
    org = await Organization.findOne({ lemonSubscriptionId: subscriptionId });
  }
  if (!org && orderId) {
    org = await Organization.findOne({ lemonOrderId: orderId });
  }

  const paidEvents = new Set([
    "order_created",
    "subscription_created",
    "subscription_updated",
    "subscription_resumed",
    "subscription_unpaused",
    "subscription_payment_success",
    "subscription_payment_recovered",
  ]);

  if (!org) {
    if (paidEvents.has(type)) {
      console.warn("[billing] lemon webhook unmatched", {
        event: type,
        hasOrganizationId: Boolean(custom.organizationId),
      });
    }
    return { received: true };
  }

  if (paidEvents.has(type)) {
    const resolved = resolvePaidPlan(custom, attrs, org);
    await applyLemonPurchaseToOrg(org, {
      planSlug: resolved?.planSlug,
      interval: resolved?.interval,
      subscriptionId: subscriptionId || undefined,
      orderId: orderId || undefined,
      customerId:
        attrs.customer_id != null ? String(attrs.customer_id) : undefined,
      status: String(attrs.status ?? "active"),
      cardBrand: attrs.card_brand != null ? String(attrs.card_brand) : null,
      cardLast4:
        attrs.card_last_four != null ? String(attrs.card_last_four) : null,
      renewsAt: attrs.renews_at != null ? String(attrs.renews_at) : null,
      ...lemonUrls(attrs),
    });
    return { received: true };
  }

  if (
    type === "subscription_cancelled" ||
    type === "subscription_expired" ||
    type === "subscription_paused"
  ) {
    org.subscriptionStatus =
      type === "subscription_paused" ? "pending_payment" : "expired";
    org.autoRenew = false;
    await asMutableOrg(org).save();
    return { received: true };
  }

  if (type === "subscription_payment_failed") {
    org.subscriptionStatus = "pending_payment";
    await asMutableOrg(org).save();
  }

  return { received: true };
}
