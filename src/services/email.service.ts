import { env } from "../config/env.js";
import {
  formatEmailTimestamp,
  summarizeUserAgent,
} from "../lib/email/clientInfo.js";
import {
  buildMfaEnableEmailCode,
  buildOrganizationInviteEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
  isEmailDeliveryEnabled,
  sendMail,
  verifyEmailTransport,
} from "../lib/email/mailer.js";

function verificationUrl(token: string): string {
  return `${env.appOrigin}/verify-email?token=${encodeURIComponent(token)}`;
}

function passwordResetUrl(token: string): string {
  return `${env.appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
}

function inviteAcceptUrl(token: string): string {
  return `${env.appOrigin}/invite/accept?token=${encodeURIComponent(token)}`;
}

function logDevFallback(kind: string, email: string, detail: string) {
  if (env.nodeEnv === "production") return;
  console.log(`[securevault-api] ${kind} for ${email}: ${detail}`);
}

export type PasswordChangedContext = {
  ip?: string | null;
  userAgent?: string | null;
  changedAt?: Date;
};

export async function sendVerificationEmail(
  email: string,
  name: string,
  rawToken: string,
): Promise<void> {
  const url = verificationUrl(rawToken);

  if (!isEmailDeliveryEnabled()) {
    logDevFallback("email verification token", email, url);
    return;
  }

  try {
    const content = buildVerificationEmail(name, url);
    await sendMail({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    console.log(`[securevault-api] verification email sent to ${email}`);
  } catch (err) {
    console.error("[securevault-api] failed to send verification email:", err);
    logDevFallback("email verification token (fallback)", email, url);
  }
}

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  rawToken: string,
): Promise<void> {
  const url = passwordResetUrl(rawToken);

  if (!isEmailDeliveryEnabled()) {
    logDevFallback("password reset", email, url);
    return;
  }

  try {
    const content = buildPasswordResetEmail(name, url);
    await sendMail({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    console.log(`[securevault-api] password reset email sent to ${email}`);
  } catch (err) {
    console.error("[securevault-api] failed to send password reset email:", err);
    logDevFallback("password reset (fallback)", email, url);
  }
}

export async function sendPasswordChangedEmail(
  email: string,
  name: string,
  context: PasswordChangedContext = {},
): Promise<void> {
  const whenLabel = formatEmailTimestamp(context.changedAt ?? new Date());
  const deviceLabel = summarizeUserAgent(context.userAgent);

  const content = buildPasswordChangedEmail(name, {
    whenLabel,
    deviceLabel,
  });

  if (!isEmailDeliveryEnabled()) {
    logDevFallback(
      "password changed notice",
      email,
      `${whenLabel} | ${deviceLabel}`,
    );
    return;
  }

  try {
    await sendMail({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    console.log(`[securevault-api] password changed email sent to ${email}`);
  } catch (err) {
    console.error(
      "[securevault-api] failed to send password changed email:",
      err,
    );
    logDevFallback(
      "password changed notice (fallback)",
      email,
      `${whenLabel} | ${deviceLabel}`,
    );
  }
}

export async function sendMfaEnableEmailCode(
  email: string,
  name: string,
  code: string,
): Promise<void> {
  if (!isEmailDeliveryEnabled()) {
    logDevFallback("MFA enable email code", email, code);
    return;
  }

  try {
    const content = buildMfaEnableEmailCode(name, code);
    await sendMail({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    console.log(`[securevault-api] MFA enable code sent to ${email}`);
  } catch (err) {
    console.error("[securevault-api] failed to send MFA enable code:", err);
    logDevFallback("MFA enable email code (fallback)", email, code);
  }
}

export async function sendOrganizationInviteEmail(input: {
  to: string;
  inviterName: string;
  organizationName: string;
  roleName: string;
  rawToken: string;
}): Promise<void> {
  const url = inviteAcceptUrl(input.rawToken);
  const content = buildOrganizationInviteEmail({
    inviterName: input.inviterName,
    organizationName: input.organizationName,
    roleName: input.roleName,
    acceptUrl: url,
  });

  if (!isEmailDeliveryEnabled()) {
    logDevFallback("organization invite", input.to, url);
    return;
  }

  try {
    await sendMail({
      to: input.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    console.log(
      `[securevault-api] organization invite email sent to ${input.to}`,
    );
  } catch (err) {
    console.error(
      "[securevault-api] failed to send organization invite email:",
      err,
    );
    logDevFallback("organization invite (fallback)", input.to, url);
  }
}

export async function sendTestEmail(to: string): Promise<void> {
  if (!isEmailDeliveryEnabled()) {
    throw new Error(
      "Email delivery is disabled. Set EMAIL_ENABLED=true and SMTP settings in backend/.env",
    );
  }

  await verifyEmailTransport();

  const url = `${env.appOrigin}/login`;
  const content = buildVerificationEmail(`${env.appName} Tester`, url);

  await sendMail({
    to,
    subject: `[Test] ${content.subject}`,
    text: `This is a ${env.appName} SMTP test email.\n\n${content.text}`,
    html: content.html,
  });
}

export { isEmailDeliveryEnabled, verifyEmailTransport };
