import type { Types } from "mongoose";
import type { MembershipStatus } from "../models/Membership.model.js";
import type { SystemRoleKey } from "../models/Role.model.js";
import type { SessionStatus } from "../models/Session.model.js";
import type { Permission } from "../lib/permissions.js";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  freeTrialUsed: boolean;
  /** True after admin removed them — login needs a fresh invite. */
  reinviteRequired: boolean;
  createdAt: Date;
};

export type RequestSession = {
  id: string;
  userId: string;
  status: SessionStatus;
  authFreshAt: Date | null;
  authHighFreshAt: Date | null;
};

export type AuthMembership = {
  id: string;
  organizationId: string;
  userId: string;
  roleId: string;
  roleName: string;
  systemKey: SystemRoleKey | null;
  permissions: Permission[];
  status: MembershipStatus;
  /** @deprecated Prefer systemKey / roleName — kept for gradual UI migration. */
  role: string;
};

export type SessionFreshness = {
  fresh: boolean;
  freshUntil: string | null;
};

export type DualSessionFreshness = {
  medium: SessionFreshness;
  high: SessionFreshness;
  fresh: boolean;
  freshUntil: string | null;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSession?: RequestSession;
      authMembership?: AuthMembership;
    }
  }
}

export type UserLean = {
  _id: Types.ObjectId;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled?: boolean;
  freeTrialUsed?: boolean;
  reinviteRequired?: boolean;
  createdAt: Date;
};

export function toAuthUser(user: UserLean): AuthUser {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    mfaEnabled: user.mfaEnabled ?? false,
    freeTrialUsed: user.freeTrialUsed ?? false,
    reinviteRequired: user.reinviteRequired ?? false,
    createdAt: user.createdAt,
  };
}
