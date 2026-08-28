import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";

/**
 * Final middleware: converts errors into a consistent JSON body.
 * Never returns stack traces or internal details to clients in production.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : "INTERNAL_ERROR";
  const message = isAppError
    ? err.message
    : "An unexpected error occurred";

  if (!isAppError || statusCode >= 500) {
    console.error("[securevault-api] error:", err);
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      ...(isAppError && err.details !== undefined
        ? { details: err.details }
        : {}),
    },
  });
}
