import crypto from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import {
  createLemonCheckout,
  updateLemonSubscription,
  variantIdForPlan,
} from "../lib/lemonSqueezy.js";
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
  lemonConfigured: boolean;
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
  lemonSubscriptionId: string | null;
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
    lemonSubscriptionId: org.lemonSubscriptionId ?? null,
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
 * Create a Lemon Squeezy hosted checkout for the org's owner/admin.
 * Card is saved by Lemon for monthly/yearly renewals.
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

  // Local/dev fallback when Lemon is not configured yet.
  if (!env.lemonSqueezy.configured) {
    if (!env.lemonSqueezy.allowMockActivate) {
      throw new AppError(
        503,
        "Lemon Squeezy is not configured. Add API keys and variant IDs to backend/.env.",
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
    throw new AppError(500, "Missing Lemon Squeezy variant ID for this plan", {
      code: "LEMON_VARIANT_MISSING",
    });
  }

  const redirectUrl = `${env.appOrigin}/app/billing?checkout=success`;

  const { checkoutUrl } = await createLemonCheckout({
    variantId,
    email: user.email,
    name: user.name,
    redirectUrl,
    custom: {
      organization_id: organization._id.toString(),
      user_id: userId,
      plan_slug: planSlug,
      billing_interval: interval,
    },
  });

  return { checkoutUrl };
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

function mapLemonStatus(
  lemonStatus: string,
): SubscriptionStatus {
  switch (lemonStatus) {
    case "on_trial":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "paused":
      return "pending_payment";
    case "cancelled":
      // Still active until ends_at if Lemon keeps access — handled by dates.
      return "active";
    case "expired":
      return "expired";
    default:
      return "pending_payment";
  }
}

type LemonWebhookPayload = {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, string>;
  };
  data?: {
    id?: string;
    type?: string;
    attributes?: Record<string, unknown>;
  };
};

export function verifyLemonWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  const secret = env.lemonSqueezy.webhookSecret;
  if (!secret) {
    // In development without secret, reject in production; allow unsigned only if explicitly empty + not production.
    if (env.nodeEnv === "production") return false;
    return true;
  }
  if (!signatureHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(signatureHeader, "utf8"),
    );
  } catch {
    return false;
  }
}

async function findOrgFromWebhook(
  attrs: Record<string, unknown>,
  custom: Record<string, string> | undefined,
): Promise<OrganizationDocument | null> {
  const orgId = custom?.organization_id;
  if (orgId) {
    const byCustom = await Organization.findById(orgId);
    if (byCustom) return byCustom;
  }

  const subscriptionId = String(
    attrs.subscription_id ?? attrs.id ?? "",
  );
  if (subscriptionId) {
    const bySub = await Organization.findOne({
      lemonSubscriptionId: subscriptionId,
    });
    if (bySub) return bySub;
  }

  const customerId = attrs.customer_id != null ? String(attrs.customer_id) : "";
  if (customerId) {
    return Organization.findOne({ lemonCustomerId: customerId });
  }

  return null;
}

/**
 * Apply Lemon subscription object fields onto the organization.
 */
async function applySubscriptionAttributes(
  org: OrganizationDocument,
  attrs: Record<string, unknown>,
  subscriptionId: string,
  custom?: Record<string, string>,
): Promise<void> {
  const lemonStatus = String(attrs.status ?? "");
  let status = mapLemonStatus(lemonStatus);

  const endsAt = attrs.ends_at ? new Date(String(attrs.ends_at)) : null;
  const renewsAt = attrs.renews_at ? new Date(String(attrs.renews_at)) : null;
  const trialEnds = attrs.trial_ends_at
    ? new Date(String(attrs.trial_ends_at))
    : null;

  // Cancelled but still in paid period → keep active until ends_at.
  if (lemonStatus === "cancelled" && endsAt && endsAt.getTime() > Date.now()) {
    status = "active";
  }
  if (lemonStatus === "cancelled" && endsAt && endsAt.getTime() <= Date.now()) {
    status = "expired";
  }

  const planSlug = (custom?.plan_slug ??
    org.planSlug ??
    "starter") as PlanSlug;
  const interval = (custom?.billing_interval ??
    org.billingInterval ??
    "monthly") as BillingInterval;

  const urls = (attrs.urls ?? {}) as Record<string, string>;
  const cardBrand = attrs.card_brand != null ? String(attrs.card_brand) : null;
  const cardLast4 =
    attrs.card_last_four != null ? String(attrs.card_last_four) : null;

  upsertPaymentMethod(org, cardBrand, cardLast4);

  org.lemonSubscriptionId = subscriptionId;
  if (attrs.customer_id != null) {
    org.lemonCustomerId = String(attrs.customer_id);
  }
  if (attrs.order_id != null) {
    org.lemonOrderId = String(attrs.order_id);
  }

  org.planSlug = planSlug === "free" ? "starter" : planSlug;
  org.plan = planDisplayName(org.planSlug as PlanSlug);
  org.billingInterval = interval;
  org.subscriptionAmountCents = amountCentsForPlan(
    org.planSlug as PlanSlug,
    interval,
  );
  org.currency = "USD";
  org.subscriptionStatus = status;
  org.autoRenew = !Boolean(attrs.cancelled) && lemonStatus !== "cancelled";
  org.autoRenewInterval = org.autoRenew ? interval : null;
  org.trialEndsAt = trialEnds;
  org.currentPeriodEndsAt = renewsAt ?? endsAt;
  org.lemonUpdatePaymentUrl = urls.update_payment_method ?? org.lemonUpdatePaymentUrl;
  org.lemonCustomerPortalUrl =
    urls.customer_portal ?? org.lemonCustomerPortalUrl;
  org.lastExpiryReminderDays = null;
  org.lastExpiryReminderAt = null;

  await asMutableOrg(org).save();
}

export async function handleLemonWebhook(
  payload: LemonWebhookPayload,
): Promise<{ ok: true; event: string }> {
  const event = payload.meta?.event_name ?? "unknown";
  const custom = payload.meta?.custom_data;
  const data = payload.data;
  if (!data?.attributes) {
    return { ok: true, event };
  }

  const attrs = data.attributes;
  const resourceType = data.type ?? "";

  if (
    event === "subscription_created" ||
    event === "subscription_updated" ||
    event === "subscription_resumed" ||
    event === "subscription_paused" ||
    event === "subscription_unpaused" ||
    event === "subscription_cancelled" ||
    event === "subscription_expired" ||
    event === "subscription_payment_success" ||
    event === "subscription_payment_recovered"
  ) {
    // subscription_payment_* payloads are subscription-invoice objects.
    const isInvoice = resourceType === "subscription-invoices";
    const subscriptionId = isInvoice
      ? String(attrs.subscription_id ?? "")
      : String(data.id ?? "");

    if (!subscriptionId) {
      return { ok: true, event };
    }

    const org = await findOrgFromWebhook(
      isInvoice ? { ...attrs, id: subscriptionId } : attrs,
      custom,
    );

    if (!org) {
      // Custom data missing on renewals — try lemonSubscriptionId only.
      const bySub = await Organization.findOne({
        lemonSubscriptionId: subscriptionId,
      });
      if (!bySub) {
        return { ok: true, event };
      }

      if (isInvoice) {
        upsertPaymentMethod(
          bySub,
          attrs.card_brand != null ? String(attrs.card_brand) : null,
          attrs.card_last_four != null ? String(attrs.card_last_four) : null,
        );
        if (event === "subscription_payment_success") {
          bySub.subscriptionStatus = "active";
          bySub.autoRenew = true;
        }
        await asMutableOrg(bySub).save();
        return { ok: true, event };
      }

      await applySubscriptionAttributes(bySub, attrs, subscriptionId, custom);
      return { ok: true, event };
    }

    if (isInvoice) {
      upsertPaymentMethod(
        org,
        attrs.card_brand != null ? String(attrs.card_brand) : null,
        attrs.card_last_four != null ? String(attrs.card_last_four) : null,
      );
      if (
        event === "subscription_payment_success" ||
        event === "subscription_payment_recovered"
      ) {
        org.subscriptionStatus = "active";
        org.autoRenew = true;
        if (org.billingInterval) {
          org.autoRenewInterval = org.billingInterval as BillingInterval;
        }
      }
      await asMutableOrg(org).save();
      return { ok: true, event };
    }

    await applySubscriptionAttributes(org, attrs, subscriptionId, custom);
    return { ok: true, event };
  }

  if (event === "subscription_payment_failed") {
    const subscriptionId = String(attrs.subscription_id ?? data.id ?? "");
    const org = await findOrgFromWebhook(attrs, custom);
    if (org) {
      org.subscriptionStatus = "pending_payment";
      await asMutableOrg(org).save();
    } else if (subscriptionId) {
      await Organization.findOneAndUpdate(
        { lemonSubscriptionId: subscriptionId },
        { $set: { subscriptionStatus: "pending_payment" } },
      );
    }
    return { ok: true, event };
  }

  return { ok: true, event };
}

/**
 * Sync auto-renew preference to Lemon (cancel at period end vs resume).
 */
export async function syncAutoRenewToLemon(
  org: OrganizationDocument,
  autoRenew: boolean,
): Promise<void> {
  if (!env.lemonSqueezy.configured || !org.lemonSubscriptionId) {
    return;
  }

  if (!autoRenew) {
    // Cancel at period end — Lemon keeps access until renews_at/ends_at.
    await updateLemonSubscription(org.lemonSubscriptionId, {
      cancelled: true,
    });
  } else {
    await updateLemonSubscription(org.lemonSubscriptionId, {
      cancelled: false,
    });
  }
}
