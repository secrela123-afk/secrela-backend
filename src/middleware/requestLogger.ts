import type { NextFunction, Request, Response } from "express";

/**
 * Lightweight request log for local development.
 * Do not log bodies — they may later contain secrets.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const started = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(
      `[securevault-api] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`,
    );
  });

  next();
}
