import type { NextFunction, Request, Response } from "express";
import {
  connectDatabase,
  isDatabaseConnected,
} from "../db/connection.js";
import { AppError } from "../lib/errors/AppError.js";

/**
 * Fail fast when MongoDB is down — avoids long hangs and opaque 500s on auth.
 * One reconnect attempt helps after transient Atlas / network blips.
 */
export function requireDatabase(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  void (async () => {
    if (!isDatabaseConnected()) {
      try {
        await connectDatabase();
      } catch {
        /* fall through to 503 */
      }
    }

    if (!isDatabaseConnected()) {
      next(
        new AppError(
          503,
          "Database is unavailable. Start MongoDB or check MONGODB_URI, then retry.",
          { code: "DATABASE_UNAVAILABLE" },
        ),
      );
      return;
    }

    next();
  })();
}
