import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
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
  amountCentsForPlan,
  planDisplayName,
  type BillingInterval,
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
  paypalConfigured: boolean;
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
    paypalConfigured: env.paypal.configured,
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
  return billingOverviewFromOrg(organization);
}

/**
 * Create a PayPal hosted subscription approval URL for the org's owner/admin.
 * The customer can pay with a Visa/Mastercard on PayPal without a PayPal account
 * (guest checkout), when PayPal allows it for that buyer country.
 */
export async function createCheckoutSessionForUser(
  userId: string,
  planSlug: "starter" | "team",
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

  if (!env.paypal.configured) {
    if (!env.paypal.allowMockActivate) {
      throw new AppError(
        503,
        "PayPal is not configured. Add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_PLAN_* ids.",
        { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
      );
    }
    await activateOrganizationSubscription(organization, planSlug, interval);
    await Organization.findByIdAndUpdate(organization._id, {
      $set: { autoRenew: true, autoRenewInterval: interval },
    });
    return { checkoutUrl: `${env.appOrigin}/app/billing?mock=1`, mockActivated: true };
  }

  const planId = paypalPlanIdFor(planSlug, interval);
  if (!planId) {
    throw new AppError(500, "Missing PayPal plan ID for this plan", {
      code: "PAYPAL_PLAN_MISSING",
    });
  }

  const returnUrl = `${env.appOrigin}/app/billing?checkout=success`;
  const cancelUrl = `${env.appOrigin}/checkout?plan=${planSlug}&interval=${interval}`;

  const { approveUrl, subscriptionId } = await createPaypalSubscription({
    planId,
    customId: encodePaypalCustomId(
      organization._id.toString(),
      planSlug,
      interval,
    ),
    returnUrl,
    cancelUrl,
    brandName: env.appName,
  });

  organization.paypalSubscriptionId = subscriptionId;
  await organization.save();

  return { checkoutUrl: approveUrl };
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
  planSlug: "starter" | "team",
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
  if (decoded.planSlug !== "starter" && decoded.planSlug !== "team") {
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

/** @deprecated Lemon path disabled — calls PayPal. */
export async function syncAutoRenewToLemon(
  org: OrganizationDocument,
  autoRenew: boolean,
): Promise<void> {
  await syncAutoRenewToPaypal(org, autoRenew);
}
