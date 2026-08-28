import { env } from "../../config/env.js";
import { escapeHtml } from "./html.js";
import {
  emailButton,
  emailLinkFallback,
  emailMetaBox,
  emailMuted,
  emailParagraph,
  renderEmailLayout,
} from "./layout.js";

export type EmailContent = {
  subject: string;
  text: string;
  html: string;
};

export type PasswordChangedMeta = {
  whenLabel: string;
  deviceLabel: string;
};

export function buildVerificationEmail(
  name: string,
  verifyUrl: string,
): EmailContent {
  const subject = `Verify your ${env.appName} email`;
  const safeName = escapeHtml(name);

  const bodyHtml = [
    emailParagraph(
      `Hi ${safeName}, welcome to ${escapeHtml(env.appName)}. Confirm your work email to finish setting up your account.`,
    ),
    emailButton(verifyUrl, "Verify email address"),
    emailLinkFallback(verifyUrl),
    emailMuted(
      "This link expires in 24 hours. If you did not create an account, you can ignore this email.",
    ),
  ].join("");

  const text = [
    `Hi ${name},`,
    "",
    `Welcome to ${env.appName}. Confirm your email address:`,
    verifyUrl,
    "",
    "This link expires in 24 hours.",
    "",
    `If you did not create a ${env.appName} account, you can ignore this email.`,
  ].join("\n");

  return {
    subject,
    text,
    html: renderEmailLayout({
      title: "Verify your email",
      preview: `Confirm your ${env.appName} email address`,
      bodyHtml,
    }),
  };
}

export function buildPasswordResetEmail(
  name: string,
  resetUrl: string,
): EmailContent {
  const subject = `Reset your ${env.appName} password`;
  const safeName = escapeHtml(name);

  const bodyHtml = [
    emailParagraph(
      `Hi ${safeName}, we received a request to reset your password. Use the secure link below to choose a new one.`,
    ),
    emailButton(resetUrl, "Reset password"),
    emailLinkFallback(resetUrl),
    emailMuted(
      "This link expires in 15 minutes. If you did not request a reset, you can ignore this email.",
    ),
  ].join("");

  const text = [
    `Hi ${name},`,
    "",
    "We received a request to reset your password.",
    resetUrl,
    "",
    "This link expires in 15 minutes.",
    "",
    "If you did not request a reset, you can ignore this email.",
  ].join("\n");

  return {
    subject,
    text,
    html: renderEmailLayout({
      title: "Reset your password",
      preview: `Reset your ${env.appName} password`,
      bodyHtml,
    }),
  };
}

export function buildPasswordChangedEmail(
  name: string,
  meta: PasswordChangedMeta,
): EmailContent {
  const subject = `Your ${env.appName} password was changed`;
  const safeName = escapeHtml(name);
  const securityUrl = `${env.appOrigin}/forgot-password`;

  const bodyHtml = [
    emailParagraph(
      `Hi ${safeName}, your ${escapeHtml(env.appName)} account password was just changed.`,
    ),
    emailMetaBox([
      { label: "When", value: meta.whenLabel },
      { label: "Device", value: meta.deviceLabel },
    ]),
    emailParagraph(
      "If this was you, no action is needed. If you did not change your password, reset it immediately and review your account activity.",
    ),
    emailButton(securityUrl, "Secure my account"),
    emailLinkFallback(securityUrl),
    emailMuted(
      "For your security, all other sessions were signed out when the password changed.",
    ),
  ].join("");

  const text = [
    `Hi ${name},`,
    "",
    `Your ${env.appName} account password was just changed.`,
    "",
    `When: ${meta.whenLabel}`,
    `Device: ${meta.deviceLabel}`,
    "",
    "If this was you, no action is needed.",
    "If you did not change your password, reset it immediately:",
    securityUrl,
    "",
    "All other sessions were signed out when the password changed.",
  ].join("\n");

  return {
    subject,
    text,
    html: renderEmailLayout({
      title: "Password changed",
      preview: `Your ${env.appName} password was changed`,
      bodyHtml,
      footerNote: `Security notice from ${env.appName}. We never email your password.`,
    }),
  };
}

export function buildMfaEnableEmailCode(
  name: string,
  code: string,
): EmailContent {
  const subject = `Your ${env.appName} security code`;
  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(code);

  const bodyHtml = [
    emailParagraph(
      `Hi ${safeName}, use this code to continue enabling two-factor authentication on your ${escapeHtml(env.appName)} account.`,
    ),
    `<p style="margin:24px 0;text-align:center;font-size:28px;font-weight:700;letter-spacing:0.2em;color:#22D35A;">${safeCode}</p>`,
    emailMuted(
      "This code expires in 10 minutes. If you did not try to enable 2FA, you can ignore this email.",
    ),
  ].join("");

  const text = [
    `Hi ${name},`,
    "",
    `Your ${env.appName} security code to enable 2FA:`,
    code,
    "",
    "This code expires in 10 minutes.",
    "If you did not request this, ignore this email.",
  ].join("\n");

  return {
    subject,
    text,
    html: renderEmailLayout({
      title: "Security code",
      preview: `Your ${env.appName} 2FA setup code`,
      bodyHtml,
    }),
  };
}

export type OrganizationInviteEmailInput = {
  inviterName: string;
  organizationName: string;
  roleName: string;
  acceptUrl: string;
};

export function buildOrganizationInviteEmail(
  input: OrganizationInviteEmailInput,
): EmailContent {
  const org = input.organizationName;
  const inviter = input.inviterName;
  const role = input.roleName;
  const subject = `Confirm your ${env.appName} invitation`;

  const bodyHtml = [
    emailParagraph(
      `${escapeHtml(inviter)} invited you to the workspace <strong style="color:#f4f7f8">${escapeHtml(org)}</strong> on ${escapeHtml(env.appName)} as ${escapeHtml(role)}.`,
    ),
    emailParagraph(
      "Confirm this invitation with the secure link below to finish joining the workspace.",
    ),
    emailButton(input.acceptUrl, "Confirm invitation"),
    emailLinkFallback(input.acceptUrl),
    emailMuted(
      "This link expires in 7 days. If you were not expecting this email, you can ignore it. We never ask for your password by email.",
    ),
  ].join("");

  const text = [
    `${inviter} invited you to the workspace ${org} on ${env.appName} as ${role}.`,
    "",
    "Confirm this invitation:",
    input.acceptUrl,
    "",
    "This link expires in 7 days.",
    "If you were not expecting this email, you can ignore it.",
    `We never ask for your password by email.`,
  ].join("\n");

  return {
    subject,
    text,
    html: renderEmailLayout({
      title: "Confirm your invitation",
      preview: `Confirm your ${env.appName} invitation to ${org}`,
      bodyHtml,
    }),
  };
}
