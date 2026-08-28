import type { NextFunction, Request, Response } from "express";

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Wraps async route handlers so rejected Promises reach the error middleware.
 * Without this, an unhandled async throw can hang or crash unpredictably.
 */
export function asyncHandler(fn: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}
