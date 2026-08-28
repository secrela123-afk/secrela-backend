import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const NOTIFICATION_TYPES = [
  "access_request.created",
  "access_request.approved",
  "access_request.denied",
  "access_request.revoked",
  /** Security/audit events surfaced to Owner/Admin bell. */
  "audit.event",
  "subscription.expiring",
  "subscription.renewed",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: true,
      maxlength: 160,
    },
    body: {
      type: String,
      required: true,
      maxlength: 500,
    },
    href: {
      type: String,
      default: "/app/access-requests",
      maxlength: 320,
    },
    readAt: {
      type: Date,
      default: null,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

export type NotificationDocument = InferSchemaType<
  typeof notificationSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const Notification: Model<NotificationDocument> =
  mongoose.models.Notification ??
  mongoose.model<NotificationDocument>("Notification", notificationSchema);
