import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { corsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFoundHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { requireTrustedOrigin } from "./middleware/requireTrustedOrigin.js";
import { healthRouter } from "./routes/health.routes.js";
import { v1Router } from "./routes/v1/index.js";
import "./types/auth.js";

/**
 * Creates the Express application (factory pattern).
 *
 * Middleware order matters:
 * 1) security headers
 * 2) parse JSON
 * 3) cookies
 * 4) CORS
 * 5) CSRF origin check (mutating)
 * 6) request log
 * 7) routes
 * 8) 404
 * 9) error handler (must be last)
 */
export function createApp() {
  const app = express();

  // Required so req.ip / req.socket reflect the real client behind Nginx later.
  if (env.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // Capture raw body for PayPal webhook signature verification.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        const url = req.url ?? "";
        if (
          url.includes("/billing/webhooks/paypal") ||
          url.includes("/billing/webhooks/paddle")
        ) {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        }
      },
    }),
  );
  app.use(cookieParser());
  app.use(cors(corsOptions));
  app.use(requireTrustedOrigin);

  if (env.nodeEnv !== "production") {
    app.use(requestLogger);
  }

  app.use("/health", healthRouter);
  app.use("/api/v1", v1Router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
