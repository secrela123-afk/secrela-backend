import mongoose from "mongoose";
import { Membership } from "../models/Membership.model.js";
import {
  Notification,
  type NotificationType,
} from "../models/Notification.model.js";
import { Role } from "../models/Role.model.js";

export type NotificationDto = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  href: string;
  readAt: Date | null;
  createdAt: Date;
  meta: Record<string, unknown>;
};

async function findOwnerAdminUserIds(
  organizationId: string,
): Promise<string[]> {
  const roles = await Role.find({
    organizationId,
    systemKey: { $in: ["owner", "admin"] },
  })
    .select("_id")
    .lean();
  if (roles.length === 0) return [];

  const rows = await Membership.find({
    organizationId,
    roleId: { $in: roles.map((r) => r._id) },
    status: { $ne: "disabled" },
  })
    .select("userId")
    .lean();

  return [...new Set(rows.map((r) => r.userId.toString()))];
}

export async function createNotificationsForUsers(input: {
  organizationId: string;
  userIds: string[];
  type: NotificationType;
  title: string;
  body: string;
  href: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const unique = [...new Set(input.userIds)].filter(Boolean);
  if (unique.length === 0) return;

  await Notification.insertMany(
    unique.map((userId) => ({
      organizationId: input.organizationId,
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      href: input.href,
      meta: input.meta ?? {},
      readAt: null,
    })),
  );
}

export async function notifyOwnersAndAdmins(input: {
  organizationId: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
  meta?: Record<string, unknown>;
  excludeUserId?: string;
}): Promise<void> {
  let userIds = await findOwnerAdminUserIds(input.organizationId);
  if (input.excludeUserId) {
    userIds = userIds.filter((id) => id !== input.excludeUserId);
  }
  await createNotificationsForUsers({
    organizationId: input.organizationId,
    userIds,
    type: input.type,
    title: input.title,
    body: input.body,
    href: input.href ?? "/app/audit",
    meta: input.meta,
  });
}

export async function listNotificationsForUser(
  organizationId: string,
  userId: string,
): Promise<{ notifications: NotificationDto[]; unreadCount: number }> {
  const rows = await Notification.find({ organizationId, userId })
    .sort({ createdAt: -1 })
    .limit(40)
    .lean();

  const unreadCount = await Notification.countDocuments({
    organizationId,
    userId,
    readAt: null,
  });

  return {
    notifications: rows.map((n) => ({
      id: n._id.toString(),
      type: n.type as NotificationType,
      title: n.title,
      body: n.body,
      href: n.href,
      readAt: n.readAt ?? null,
      createdAt: n.createdAt,
      meta: (n.meta as Record<string, unknown>) ?? {},
    })),
    unreadCount,
  };
}

export async function markNotificationRead(
  organizationId: string,
  userId: string,
  notificationId: string,
): Promise<NotificationDto | null> {
  if (!mongoose.isValidObjectId(notificationId)) return null;
  const row = await Notification.findOneAndUpdate(
    { _id: notificationId, organizationId, userId },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();
  if (!row) return null;
  return {
    id: row._id.toString(),
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
    meta: (row.meta as Record<string, unknown>) ?? {},
  };
}

export async function markAllNotificationsRead(
  organizationId: string,
  userId: string,
): Promise<{ marked: number }> {
  const result = await Notification.updateMany(
    { organizationId, userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { marked: result.modifiedCount };
}

export async function deleteNotificationForUser(
  organizationId: string,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(notificationId)) return false;
  const result = await Notification.deleteOne({
    _id: notificationId,
    organizationId,
    userId,
  });
  return result.deletedCount > 0;
}

export async function deleteAllNotificationsForUser(
  organizationId: string,
  userId: string,
): Promise<{ deleted: number }> {
  const result = await Notification.deleteMany({ organizationId, userId });
  return { deleted: result.deletedCount };
}
