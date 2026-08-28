import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { setSessionCookie } from "../lib/cookies.js";
import { getRequestClientMeta } from "../lib/requestClient.js";
import type {
  MfaCodeBody,
  MfaEnableStartBody,
  MfaEnableVerifyEmailBody,
} from "../schemas/auth.schemas.js";
import {
  recordAuditForUserOrganizations,
} from "../services/audit.service.js";
import {
  beginMfaEnableChallenge,
  completeMfaLogin,
  disableMfa,
  enableMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
  startMfaSetup,
  verifyMfaEnableEmailCode,
} from "../services/mfa.service.js";

function requireUser(req: Request) {
  if (!req.authUser || !req.authSession) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }
  return { user: req.authUser, session: req.authSession };
}

export async function enableStart(req: Request, res: Response) {
  const { user, session } = requireUser(req);
  const body = req.body as MfaEnableStartBody;
  const result = await beginMfaEnableChallenge(user.id, session.id, body);
  res.status(200).json(result);
}

export async function enableVerifyEmail(req: Request, res: Response) {
  const { user } = requireUser(req);
  const body = req.body as MfaEnableVerifyEmailBody;
  const result = await verifyMfaEnableEmailCode(user.id, body.code);
  res.status(200).json(result);
}

export async function setup(req: Request, res: Response) {
  const { user } = requireUser(req);
  const result = await startMfaSetup(user.id);
  res.status(200).json({
    secret: result.secret,
    otpauthUri: result.otpauthUri,
  });
}

export async function enable(req: Request, res: Response) {
  const { user } = requireUser(req);
  const body = req.body as MfaCodeBody;
  const result = await enableMfa(user.id, body.code);
  const client = getRequestClientMeta(req);
  void recordAuditForUserOrganizations({
    userId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "mfa.enabled",
    ip: client.ip,
    userAgent: client.userAgent,
  });
  res.status(200).json({
    user: result.user,
    recoveryCodes: result.recoveryCodes,
  });
}

export async function disable(req: Request, res: Response) {
  const { user } = requireUser(req);
  const body = req.body as MfaCodeBody;
  const updated = await disableMfa(user.id, body.code);
  const client = getRequestClientMeta(req);
  void recordAuditForUserOrganizations({
    userId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "mfa.disabled",
    ip: client.ip,
    userAgent: client.userAgent,
  });
  res.status(200).json({ user: updated });
}

export async function regenerate(req: Request, res: Response) {
  const { user } = requireUser(req);
  const body = req.body as MfaCodeBody;
  const recoveryCodes = await regenerateRecoveryCodes(user.id, body.code);
  res.status(200).json({ recoveryCodes });
}

export async function status(req: Request, res: Response) {
  const { user } = requireUser(req);
  const mfa = await getMfaStatus(user.id);
  res.status(200).json({ mfa });
}

export async function verify(req: Request, res: Response) {
  const { user, session } = requireUser(req);
  const body = req.body as MfaCodeBody;
  const result = await completeMfaLogin(user.id, session.id, body.code, req);
  const client = getRequestClientMeta(req);
  void recordAuditForUserOrganizations({
    userId: result.user.id,
    actorName: result.user.name,
    actorEmail: result.user.email,
    action: "login.success",
    ip: client.ip,
    userAgent: client.userAgent,
    metadata: { via: "mfa" },
  });
  setSessionCookie(res, result.rawSessionToken);
  res.status(200).json({ mfaRequired: false, user: result.user });
}
