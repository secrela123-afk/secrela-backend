import "dotenv/config";
import { isEmailDeliveryEnabled, sendTestEmail } from "../src/services/email.service.js";

const to = process.argv[2];

if (!to) {
  console.error("Usage: npm run test:email -- you@example.com");
  process.exit(1);
}

async function main() {
  if (!isEmailDeliveryEnabled()) {
    console.error(
      "[securevault-api] Email is disabled. Set EMAIL_ENABLED=true and SMTP_* in backend/.env",
    );
    process.exit(1);
  }

  await sendTestEmail(to);
  console.log(`[securevault-api] test email sent to ${to}`);
}

main().catch((err) => {
  console.error("[securevault-api] test email failed:", err);
  process.exit(1);
});
