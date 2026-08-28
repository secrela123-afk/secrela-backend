import type { CorsOptions } from "cors";
import { env } from "../config/env.js";

/**
 * Browser apps (Next.js on another origin) need CORS when calling the API.
 * We allow only configured origins — never "*" with credentials later.
 */
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Non-browser tools (curl, server-to-server) often send no Origin
    if (!origin) {
      callback(null, true);
      return;
    }

    if (env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
};
