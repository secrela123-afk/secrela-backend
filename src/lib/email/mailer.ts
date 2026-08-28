import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../../config/env.js";

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

let transporter: Transporter | null = null;

export function isEmailDeliveryEnabled(): boolean {
  return env.email.enabled;
}

function getTransporter(): Transporter {
  if (!env.email.enabled) {
    throw new Error("Email delivery is not configured");
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.smtpHost,
      port: env.email.smtpPort,
      secure: env.email.smtpSecure,
      auth: {
        user: env.email.smtpUser,
        pass: env.email.smtpPass,
      },
    });
  }

  return transporter;
}

export async function verifyEmailTransport(): Promise<void> {
  const transport = getTransporter();
  await transport.verify();
}

export async function sendMail(input: SendMailInput): Promise<void> {
  const transport = getTransporter();

  await transport.sendMail({
    from: env.email.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    // Helps clients treat these as transactional (same path as verify / reset).
    replyTo: env.email.from,
    headers: {
      "X-Auto-Response-Suppress": "OOF, AutoReply",
      "Auto-Submitted": "auto-generated",
      "X-Entity-Type": "transactional",
    },
  });
}

export {
  buildMfaEnableEmailCode,
  buildOrganizationInviteEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
} from "./templates.js";
