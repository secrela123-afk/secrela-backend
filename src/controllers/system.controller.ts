import type { Request, Response } from "express";

/**
 * API meta endpoint — proves /api/v1 is mounted.
 * No business data; no auth. Pattern preview: Route → Controller.
 */
export function getApiMeta(_req: Request, res: Response) {
  res.status(200).json({
    name: "securevault-api",
    version: "v1",
    status: "ok",
  });
}
