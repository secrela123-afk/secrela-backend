import type { Request } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import {
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "../lib/password.js";
import { getRequestClientMeta } from "../lib/requestClient.js";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import { Invitation } from "../models/Invitation.model.js";
import { Membership } from "../models/Membership.model.js";
import {
  Session,
  type SessionStatus,
} from "../models/Session.model.js";
import { User } from "../models/User.model.js";
import type { LoginBody, RegisterBody } from "../schemas/auth.schemas.js";
import { toAuthUser, type AuthUser } from "../types/auth.js";
import type { PlanSlug } from "../lib/subscriptionPlans.js";
import { createOrganizationAtSignup } from "./signup.service.js";
import { sendVerificationEmail } from "./email.service.js";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MFA_PENDING_TTL_MS = 10 * 60 * 1000;

export async function createSessionForUser(
  userId: string,
  req: Request,
  options?: { status?: SessionStatus; ttlMs?: number },
): Promise<string> {
  const status = options?.status ?? "full";
  const ttlMs = options?.ttlMs ?? env.sessionTtlMs;
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const { ip, userAgent } = getRequestClientMeta(req);

  await Session.create({
    tokenHash,
    userId,
    status,
    expiresAt: new Date(Date.now() + ttlMs),
    ip,
    userAgent,
    lastSeenAt: new Date(),
    // Full login proves password; MFA login also proves the second factor.
    // Both freshness clocks start so LOW/MEDIUM/HIGH work until TTL expires.
    authFreshAt: status === "full" ? new Date() : null,
    authHighFreshAt: status === "full" ? new Date() : null,
  });

  return rawToken;
}

export type LoginResult =
  | {
      status: "authenticated";
      user: AuthUser;
      rawSessionToken: string;
    }
  | {
      status: "mfa_required";
      user: Pick<AuthUser, "id" | "email" | "name">;
      rawSessionToken: string;
    };

export async function registerUser(
  input: RegisterBody,
  req: Request,
): Promise<{ user: AuthUser; rawSessionToken: string }> {
  const email = input.email.toLowerCase().trim();
  const companyName = input.companyName.trim();
  /** Invite accept creates user only — no new workspace / free trial. */
  const createOrganization = input.createOrganization !== false;
  // Product rule: every new workspace starts on the free trial.
  // Paid plans are activated later from pricing / checkout.
  const planSlug: PlanSlug = "free";

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    if (createOrganization && existing.freeTrialUsed) {
      throw new AppError(409, "Free trial already used for this email", {
        code: "FREE_TRIAL_ALREADY_USED",
      });
    }
    throw new AppError(409, "Email is already registered", {
      code: "EMAIL_IN_USE",
    });
  }

  const passwordHash = await hashPassword(input.password);
  const verificationRaw = generateOpaqueToken();
  const verificationHash = hashToken(verificationRaw);
  const startingFreeTrial = createOrganization;

  const user = await User.create({
    email,
    name: companyName,
    passwordHash,
    emailVerified: false,
    freeTrialUsed: startingFreeTrial,
    emailVerificationTokenHash: verificationHash,
    emailVerificationExpiresAt: new Date(
      Date.now() + EMAIL_VERIFICATION_TTL_MS,
    ),
  });

  if (createOrganization) {
    await createOrganizationAtSignup(
      user,
      companyName,
      planSlug,
      input.phone,
    );
  }

  await sendVerificationEmail(email, companyName, verificationRaw);

  const rawSessionToken = await createSessionForUser(user._id.toString(), req);

  return {
    user: toAuthUser({
      _id: user._id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      freeTrialUsed: user.freeTrialUsed,
      reinviteRequired: user.reinviteRequired,
      createdAt: user.createdAt,
    }),
    rawSessionToken,
  };
}

export async function loginUser(
  input: LoginBody,
  req: Request,
): Promise<LoginResult> {
  const email = input.email.toLowerCase().trim();

  const user = await User.findOne({ email }).select("+passwordHash");
  const hash = user?.passwordHash ?? (await getDummyPasswordHash());
  const valid = await verifyPassword(hash, input.password);

  if (!user || !valid) {
    throw new AppError(401, "Invalid email or password", {
      code: "INVALID_CREDENTIALS",
    });
  }

  if (!user.emailVerified) {
    throw new AppError(
      403,
      "Verify your email before signing in. Open the link we sent you.",
      {
        code: "EMAIL_NOT_VERIFIED",
      },
    );
  }

  if (user.reinviteRequired) {
    await assertValidReinviteToken(user.email, input.inviteToken);
  }

  const membership = await Membership.findOne({ userId: user._id }).lean();
  if (membership && (membership.status ?? "active") === "disabled") {
    throw new AppError(
      403,
      "Your account has been disabled by an organization admin. You cannot sign in until they enable it again.",
      { code: "MEMBER_DISABLED" },
    );
  }

  if (user.mfaEnabled) {
    const rawSessionToken = await createSessionForUser(
      user._id.toString(),
      req,
      { status: "mfa_pending", ttlMs: MFA_PENDING_TTL_MS },
    );

    return {
      status: "mfa_required",
      rawSessionToken,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
      },
    };
  }

  const rawSessionToken = await createSessionForUser(user._id.toString(), req);

  return {
    status: "authenticated",
    rawSessionToken,
    user: toAuthUser({
      _id: user._id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      freeTrialUsed: user.freeTrialUsed,
      reinviteRequired: user.reinviteRequired,
      createdAt: user.createdAt,
    }),
  };
}

/**
 * Removed members may only sign in through a fresh pending invitation link.
 */
async function assertValidReinviteToken(
  email: string,
  inviteToken: string | undefined,
): Promise<void> {
  if (!inviteToken?.trim()) {
    throw new AppError(
      403,
      "Your access was removed. Open a new invitation email to sign in again.",
      { code: "REINVITE_REQUIRED" },
    );
  }

  const tokenHash = hashToken(inviteToken.trim());
  const invite = await Invitation.findOne({
    tokenHash,
    email: email.toLowerCase(),
    status: "pending",
  }).lean();

  if (
    !invite ||
    invite.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError(
      403,
      "Your access was removed. Use a valid new invitation link to sign in.",
      { code: "REINVITE_REQUIRED" },
    );
  }
}

export async function logoutSession(
  rawToken: string | undefined,
): Promise<void> {
  if (!rawToken) return;

  const tokenHash = hashToken(rawToken);
  await Session.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function logoutAllSessions(userId: string): Promise<void> {
  await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Hard-delete all sessions for a user (used when removing a member). */
export async function destroyAllSessions(userId: string): Promise<void> {
  await Session.deleteMany({ userId });
}

export async function verifyEmailWithToken(rawToken: string): Promise<AuthUser> {
  const tokenHash = hashToken(rawToken);

  const user = await User.findOneAndUpdate(
    {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    },
    {
      new: true,
      // token fields are select:false — still match in filter; return public fields
    },
  );

  if (!user) {
    throw new AppError(400, "Invalid or expired verification token", {
      code: "INVALID_VERIFICATION_TOKEN",
    });
  }

  return toAuthUser({
    _id: user._id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    mfaEnabled: user.mfaEnabled,
    freeTrialUsed: user.freeTrialUsed,
    reinviteRequired: user.reinviteRequired,
    createdAt: user.createdAt,
  });
}

export async function resolveSession(
  rawToken: string,
  req?: Request,
): Promise<{
  user: AuthUser;
  sessionId: string;
  status: SessionStatus;
  authFreshAt: Date | null;
  authHighFreshAt: Date | null;
} | null> {
  const tokenHash = hashToken(rawToken);

  const session = await Session.findOne({
    tokenHash,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!session) return null;

  const user = await User.findById(session.userId);
  if (!user) return null;

  session.lastSeenAt = new Date();

  if (req) {
    const { ip, userAgent } = getRequestClientMeta(req);
    if (ip) session.ip = ip;
    if (userAgent) session.userAgent = userAgent;
  }

  await session.save();

  return {
    sessionId: session._id.toString(),
    status: session.status ?? "full",
    authFreshAt: session.authFreshAt ?? null,
    authHighFreshAt: session.authHighFreshAt ?? null,
    user: toAuthUser({
      _id: user._id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      freeTrialUsed: user.freeTrialUsed,
      reinviteRequired: user.reinviteRequired,
      createdAt: user.createdAt,
    }),
  };
}
