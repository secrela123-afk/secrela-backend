import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const ORGANIZATION_TYPES = [
  "startup",
  "sme",
  "enterprise",
  "agency",
  "other",
] as const;

export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const COMPANY_SIZES = [
  "1-10",
  "11-50",
  "51-200",
  "201-1000",
  "1000+",
] as const;

export type CompanySize = (typeof COMPANY_SIZES)[number];

const organizationSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 140,
    },
    /** Company profile — collected during workspace setup */
    type: {
      type: String,
      enum: ORGANIZATION_TYPES,
      required: true,
      default: "other",
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      default: "—",
    },
    planSlug: {
      type: String,
      enum: ["free", "starter", "team", "business", "enterprise"],
      default: "starter",
    },
    subscriptionStatus: {
      type: String,
      enum: ["trialing", "active", "pending_payment", "expired"],
      default: "pending_payment",
    },
    /** monthly | yearly — null for free trial / enterprise custom */
    billingInterval: {
      type: String,
      enum: ["monthly", "yearly"],
      default: null,
    },
    /** Charged amount for the current period (USD cents). Null until activated. */
    subscriptionAmountCents: {
      type: Number,
      default: null,
      min: 0,
    },
    currency: {
      type: String,
      default: "USD",
      maxlength: 3,
    },
    /** Owner preference: renew automatically when period ends (no Stripe yet — extends in DB). */
    autoRenew: {
      type: Boolean,
      default: false,
    },
    autoRenewInterval: {
      type: String,
      enum: ["monthly", "yearly"],
      default: null,
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
    currentPeriodEndsAt: {
      type: Date,
      default: null,
    },
    /** Last expiry reminder day bucket sent (5 | 3 | 1). */
    lastExpiryReminderDays: {
      type: Number,
      default: null,
    },
    lastExpiryReminderAt: {
      type: Date,
      default: null,
    },
    /** Bonus trial days granted by owner (capped by MAX_TRIAL_BONUS_DAYS). */
    trialBonusDaysGranted: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Display-only plan label for the MVP shell.
     */
    plan: {
      type: String,
      default: "Starter",
      maxlength: 60,
    },
    /** Extended profile — filled later in Settings */
    website: {
      type: String,
      default: null,
      trim: true,
      maxlength: 320,
    },
    country: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    },
    companySize: {
      type: String,
      default: null,
    },
    industry: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },
    billingEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    address: {
      type: String,
      default: null,
      trim: true,
      maxlength: 400,
    },
    /** Lemon Squeezy — Merchant of Record IDs (never store full card numbers). */
    lemonCustomerId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    lemonSubscriptionId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
      index: true,
    },
    lemonOrderId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    /** Current payment method on the active subscription (display only). */
    cardBrand: {
      type: String,
      default: null,
      trim: true,
      maxlength: 32,
    },
    cardLast4: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4,
    },
    /**
     * Cards we have seen via Lemon webhooks (history + current).
     * Switching the active card is done in Lemon’s customer portal —
     * we do not store PAN/CVV.
     */
    paymentMethods: {
      type: [
        {
          _id: false,
          brand: { type: String, required: true, maxlength: 32 },
          last4: { type: String, required: true, maxlength: 4 },
          isDefault: { type: Boolean, default: false },
          firstSeenAt: { type: Date, default: Date.now },
          lastUsedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    /** Hosted URL to update the card / manage subscription (from Lemon). */
    lemonUpdatePaymentUrl: {
      type: String,
      default: null,
      maxlength: 800,
    },
    lemonCustomerPortalUrl: {
      type: String,
      default: null,
      maxlength: 800,
    },
    /** PayPal Subscriptions ID (current billing provider). */
    paypalSubscriptionId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
      index: true,
    },
    /**
     * Org DEK wrapped by platform KEK (AD-005).
     * Never store the raw DEK or secret plaintext here.
     */
    dekWrapped: {
      type: {
        v: { type: Number, required: true },
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ct: { type: String, required: true },
      },
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export type OrganizationDocument = InferSchemaType<typeof organizationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Organization: Model<OrganizationDocument> =
  mongoose.models.Organization ??
  mongoose.model<OrganizationDocument>("Organization", organizationSchema);
