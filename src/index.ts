import "dotenv/config";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./db/connection.js";
import { isEmailDeliveryEnabled } from "./services/email.service.js";

async function main() {
  // Start HTTP first so the frontend can reach /health even when Mongo is down.
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[securevault-api] listening on http://localhost:${env.port}`);
    console.log(`[securevault-api] health: http://localhost:${env.port}/health`);
    console.log(`[securevault-api] ready:  http://localhost:${env.port}/health/ready`);
    console.log(
      `[securevault-api] email:  ${isEmailDeliveryEnabled() ? "SMTP enabled" : "console fallback (set EMAIL_ENABLED=true)"}`,
    );
    console.log(
      `[securevault-api] google: ${env.googleOAuth.enabled ? "OAuth enabled" : "OAuth DISABLED (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in backend/.env)"}`,
    );
    console.log(
      `[securevault-api] paypal: ${
        env.paypal.configured
          ? `enabled (${env.paypal.mode})`
          : "DISABLED (missing client or plan ids)"
      }`,
    );
    console.log(
      `[securevault-api] paddle: ${
        env.paddle.configured
          ? `enabled (${env.paddle.mode})`
          : "DISABLED (missing api key, client token, or price ids)"
      }`,
    );
    const mongoHost = env.mongodbUri.includes("127.0.0.1")
      ? "local"
      : "remote";
    console.log(`[securevault-api] mongo target: ${mongoHost}`);
  });

  try {
    await connectDatabase();
  } catch (err) {
    console.error(
      "[securevault-api] MongoDB connect failed — API is up but auth will return 503 until DB is available:",
      err,
    );
  }

  const shutdown = async (signal: string) => {
    console.log(`[securevault-api] received ${signal}, shutting down…`);
    server.close(async () => {
      try {
        await disconnectDatabase();
        console.log("[securevault-api] shutdown complete");
        process.exit(0);
      } catch (shutdownErr) {
        console.error("[securevault-api] shutdown error:", shutdownErr);
        process.exit(1);
      }
    });
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  console.error("[securevault-api] failed to start:", err);
  process.exit(1);
});
