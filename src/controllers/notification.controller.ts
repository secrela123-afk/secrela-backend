import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import {
  deleteAllNotificationsForUser,
  deleteNotificationForUser,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notification.service.js";

function requireUserId(req: Request): string {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }
  return req.authUser.id;
}

function requireOrganizationId(req: Request): string {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.organizationId;
}

export async function list(req: Request, res: Response) {
  const result = await listNotificationsForUser(
    requireOrganizationId(req),
    requireUserId(req),
  );
  res.status(200).json(result);
}

export async function markRead(req: Request, res: Response) {
  const notification = await markNotificationRead(
    requireOrganizationId(req),
    requireUserId(req),
    req.params.notificationId as string,
  );
  if (!notification) {
    throw new AppError(404, "Notification not found", {
      code: "NOTIFICATION_NOT_FOUND",
    });
  }
  res.status(200).json({ notification });
}

export async function markAllRead(req: Request, res: Response) {
  const result = await markAllNotificationsRead(
    requireOrganizationId(req),
    requireUserId(req),
  );
  res.status(200).json(result);
}

export async function remove(req: Request, res: Response) {
  const ok = await deleteNotificationForUser(
    requireOrganizationId(req),
    requireUserId(req),
    req.params.notificationId as string,
  );
  if (!ok) {
    throw new AppError(404, "Notification not found", {
      code: "NOTIFICATION_NOT_FOUND",
    });
  }
  res.status(200).json({ deleted: true });
}

export async function removeAll(req: Request, res: Response) {
  const result = await deleteAllNotificationsForUser(
    requireOrganizationId(req),
    requireUserId(req),
  );
  res.status(200).json(result);
}
