import mongoose from "mongoose";
import { env } from "../config/env.js";

/**
 * MongoDB connection via Mongoose.
 *
 * Phase scope: connect/disconnect + status only.
 * No product schemas/models yet (User, Organization, … come later).
 */

export type DatabaseStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting";

const STATE_MAP: Record<number, DatabaseStatus> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

let listenersAttached = false;

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on("connected", () => {
    console.log("[securevault-api] MongoDB connected");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[securevault-api] MongoDB connection error:", err);
  });

  mongoose.connection.on("disconnected", () => {
    console.log("[securevault-api] MongoDB disconnected");
  });
}

export function getDatabaseStatus(): DatabaseStatus {
  return STATE_MAP[mongoose.connection.readyState] ?? "disconnected";
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function connectDatabase(): Promise<void> {
  if (isDatabaseConnected()) {
    return;
  }

  attachConnectionListeners();
  await mongoose.connect(env.mongodbUri, {
    serverSelectionTimeoutMS: 8_000,
    // Keep trying after transient Atlas / network blips
    maxPoolSize: 10,
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (getDatabaseStatus() === "disconnected") {
    return;
  }

  await mongoose.disconnect();
}
