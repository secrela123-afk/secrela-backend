import { env } from "../../config/env.js";
import { escapeHtml } from "./html.js";

export type EmailLayoutInput = {
  /** Main heading inside the card */
  title: string;
  /** Preheader / preview text for some email clients */
  preview?: string;
  /** Inner HTML (already escaped where needed) */
  bodyHtml: string;
  /** Optional footer note under the card */
  footerNote?: string;
};

/**
 * Shared Secrela / SecureVault email chrome.
 * All transactional emails should wrap content with this layout.
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const app = escapeHtml(env.appName);
  const preview = escapeHtml(input.preview ?? input.title);
  const footer =
    input.footerNote ??
    `You’re receiving this because of activity on your ${env.appName} account.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#030912;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preview}</div>
  <div style="font-family:Inter,Segoe UI,Arial,sans-serif;line-height:1.6;color:#f4f7f8;background:#030912;padding:32px 16px">
    <div style="max-width:520px;margin:0 auto">
      <div style="margin:0 0 16px;text-align:left">
        <span style="display:inline-block;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#22d35a;font-weight:700">${app}</span>
      </div>
      <div style="background:#0d151f;border:1px solid #1b2935;border-radius:14px;padding:28px 28px 24px;box-shadow:0 0 0 1px rgb(34 211 90 / 0.04)">
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700;color:#f4f7f8">${escapeHtml(input.title)}</h1>
        ${input.bodyHtml}
      </div>
      <p style="margin:18px 8px 0;font-size:12px;line-height:1.5;color:#687582">${escapeHtml(footer)}</p>
    </div>
  </div>
</body>
</html>`;
}

export function emailParagraph(text: string): string {
  return `<p style="margin:0 0 16px;color:#a7b1bb;font-size:15px">${text}</p>`;
}

export function emailMuted(text: string): string {
  return `<p style="margin:16px 0 0;color:#687582;font-size:13px;line-height:1.5">${text}</p>`;
}

export function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#22d35a;color:#030912;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px;margin:4px 0 8px">${escapeHtml(label)}</a>`;
}

export function emailLinkFallback(href: string): string {
  return `<p style="margin:16px 0 0;color:#687582;font-size:13px">Or copy this link:<br><span style="word-break:break-all;color:#a7b1bb">${href}</span></p>`;
}

export function emailMetaBox(rows: Array<{ label: string; value: string }>): string {
  const lines = rows
    .map(
      (row) =>
        `<tr>
          <td style="padding:8px 0;color:#687582;font-size:13px;width:110px;vertical-align:top">${escapeHtml(row.label)}</td>
          <td style="padding:8px 0;color:#f4f7f8;font-size:13px;font-weight:600;vertical-align:top">${escapeHtml(row.value)}</td>
        </tr>`,
    )
    .join("");

  return `<div style="margin:8px 0 4px;padding:12px 14px;border-radius:10px;border:1px solid #1b2935;background:#091018">
    <table role="presentation" style="width:100%;border-collapse:collapse">${lines}</table>
  </div>`;
}
