import type { Request, Response, NextFunction } from "express";
import { AppError } from "../lib/errors/AppError.js";

/**
 * Runs when no prior route matched. Forwards a 404 AppError to errorHandler.
 */
export function notFoundHandler(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  next(
    new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`, {
      code: "NOT_FOUND",
    }),
  );
}
