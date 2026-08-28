import type { Request, Response } from "express";
import { clearSessionCookie, setSessionCookie } from "../lib/cookies.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import { getRequestClientMeta } from "../lib/requestClient.js";
import { toDualSessionFreshness } from "../lib/sessionFreshness.js";
import {
  loginUser,
  logoutAllSessions,
  logoutSession,
  MFA_PENDING_TTL_MS,
  registerUser,
  verifyEmailWithToken,
} from "../services/auth.service.js";
import {
  recordAuditForUserOrganizations,
} from "../services/audit.service.js";
import {
  requestPasswordReset,
  resetPasswordWithToken,
} from "../services/passwordReset.service.js";
import { reauthenticateSession } from "../services/reauth.service.js";
import type {
  ForgotPasswordBody,
  LoginBody,
  ReauthenticateBody,
  RegisterBody,
  ResetPasswordBody,
  VerifyEmailBody,
} from "../schemas/auth.schemas.js";

export async function register(req: Request, res: Response) {
  const body = req.body as RegisterBody;
  const result = await registerUser(body, req);
  setSessionCookie(res, result.rawSessionToken);
  res.status(201).json({ mfaRequired: false, user: result.user });
}

export async function login(req: Request, res: Response) {
  const body = req.body as LoginBody;
  const client = getRequestClientMeta(req);

  try {
    const result = await loginUser(body, req);

    if (result.status === "mfa_required") {
      setSessionCookie(res, result.rawSessionToken, MFA_PENDING_TTL_MS);
      res.status(200).json({
        mfaRequired: true,
        user: result.user,
      });
      return;
    }

    void recordAuditForUserOrganizations({
      userId: result.user.id,
      actorName: result.user.name,
      actorEmail: result.user.email,
      action: "login.success",
      ip: client.ip,
      userAgent: client.userAgent,
    });

    setSessionCookie(res, result.rawSessionToken);
    res.status(200).json({ mfaRequired: false, user: result.user });
  } catch (err) {
    if (
      err instanceof AppError &&
      err.code === "INVALID_CREDENTIALS" &&
      body.email
    ) {
      const email = body.email.toLowerCase().trim();
      const { User } = await import("../models/User.model.js");
      const existing = await User.findOne({ email }).select("_id name email").lean();
      if (existing) {
        void recordAuditForUserOrganizations({
          userId: existing._id.toString(),
          actorName: existing.name,
          actorEmail: existing.email,
          action: "login.failed",
          ip: client.ip,
          userAgent: client.userAgent,
        });
      }
    }
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  const rawToken = req.cookies?.[env.cookieName] as string | undefined;
  const client = getRequestClientMeta(req);

  if (req.authUser) {
    void recordAuditForUserOrganizations({
      userId: req.authUser.id,
      actorName: req.authUser.name,
      actorEmail: req.authUser.email,
      action: "logout",
      ip: client.ip,
      userAgent: client.userAgent,
    });
  } else if (rawToken) {
    try {
      const { hashToken } = await import("../lib/tokens.js");
      const { Session } = await import("../models/Session.model.js");
      const { User } = await import("../models/User.model.js");
      const session = await Session.findOne({
        tokenHash: hashToken(rawToken),
        revokedAt: null,
      })
        .select("userId")
        .lean();
      if (session) {
        const user = await User.findById(session.userId)
          .select("name email")
          .lean();
        if (user) {
          void recordAuditForUserOrganizations({
            userId: user._id.toString(),
            actorName: user.name,
            actorEmail: user.email,
            action: "logout",
            ip: client.ip,
            userAgent: client.userAgent,
          });
        }
      }
    } catch {
      // Audit must not block logout.
    }
  }

  await logoutSession(rawToken);
  clearSessionCookie(res);
  res.status(204).send();
}

export async function logoutAll(req: Request, res: Response) {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  await logoutAllSessions(req.authUser.id);
  clearSessionCookie(res);
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  if (!req.authUser || !req.authSession) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  res.status(200).json({
    user: req.authUser,
    session: toDualSessionFreshness(
      req.authSession.authFreshAt,
      req.authSession.authHighFreshAt,
      env.stepUpTtlMs,
    ),
  });
}

export async function reauthenticate(req: Request, res: Response) {
  if (!req.authUser || !req.authSession) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const body = req.body as ReauthenticateBody;
  const session = await reauthenticateSession(
    req.authUser.id,
    req.authSession.id,
    body.password,
    body.code,
    body.level,
  );

  res.status(200).json({
    user: req.authUser,
    session,
  });
}

export async function verifyEmail(req: Request, res: Response) {
  const body = req.body as VerifyEmailBody;
  const user = await verifyEmailWithToken(body.token);
  res.status(200).json({ user });
}

export async function forgotPassword(req: Request, res: Response) {
  const body = req.body as ForgotPasswordBody;
  const result = await requestPasswordReset(body);
  res.status(200).json(result);
}

export async function resetPassword(req: Request, res: Response) {
  const body = req.body as ResetPasswordBody;
  const result = await resetPasswordWithToken(body, req);
  res.status(200).json(result);
}
