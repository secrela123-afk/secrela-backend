import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "../lib/errors/AppError.js";

/**
 * Validates req.body with Zod. On success, replaces req.body with parsed data.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        new AppError(400, "Validation failed", {
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten(),
        }),
      );
      return;
    }

    req.body = parsed.data;
    next();
  };
}
