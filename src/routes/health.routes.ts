import { Router } from "express";
import {
  getDatabaseStatus,
  isDatabaseConnected,
} from "../db/connection.js";

export const healthRouter = Router();

/**
 * Liveness: process is up (does not require DB).
 * Useful for “is the Node process running?”
 */
healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "securevault-api",
    database: {
      status: getDatabaseStatus(),
    },
  });
});

/**
 * Readiness: ready to accept traffic that needs the database.
 * Returns 503 if MongoDB is not connected.
 */
healthRouter.get("/ready", (_req, res) => {
  const databaseStatus = getDatabaseStatus();
  const ready = isDatabaseConnected();

  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: "securevault-api",
    database: {
      status: databaseStatus,
    },
  });
});
