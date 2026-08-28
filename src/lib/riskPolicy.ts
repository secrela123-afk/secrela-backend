/**
 * Centralized authentication strength requirements by operation risk.
 *
 * LOW    — valid FULL session only
 * MEDIUM — FULL + recent password proof (authFreshAt)
 * HIGH   — FULL + recent password proof + MFA factor when MFA is enabled
 *          (authHighFreshAt). If MFA is off, password proof alone refreshes high.
 *
 * Controllers should not invent ad-hoc password/TOTP checks.
 * Use requireFullAuth / requireFreshAuth / requireHighRiskAuth instead.
 */

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type RiskRequirement = {
  level: RiskLevel;
  fullSession: boolean;
  passwordFresh: boolean;
  mfaFactorWhenEnabled: boolean;
  examples: string[];
};

export const RISK_POLICY: Record<RiskLevel, RiskRequirement> = {
  low: {
    level: "low",
    fullSession: true,
    passwordFresh: false,
    mfaFactorWhenEnabled: false,
    examples: [
      "Open dashboard",
      "Normal navigation",
      "View non-sensitive account info",
      "List vaults / secrets metadata (not plaintext values)",
    ],
  },
  medium: {
    level: "medium",
    fullSession: true,
    passwordFresh: true,
    mfaFactorWhenEnabled: false,
    examples: [
      "Change password",
      "Change email",
      "Start MFA setup",
      "Important account / security settings",
    ],
  },
  high: {
    level: "high",
    fullSession: true,
    passwordFresh: true,
    mfaFactorWhenEnabled: true,
    examples: [
      "Reveal stored secret plaintext",
      "Export secrets",
      "Disable MFA",
      "Regenerate recovery codes",
      "Delete organization",
      "Critical security changes",
    ],
  },
};

/** Operations mapped for documentation and future route annotation. */
export const OPERATION_RISK = {
  dashboard: "low",
  orgRead: "low",
  mfaStatus: "low",
  mfaSetup: "medium",
  mfaEnable: "medium",
  changePassword: "medium",
  changeEmail: "medium",
  logoutAll: "high",
  mfaDisable: "high",
  mfaRecoveryRegenerate: "high",
  secretReveal: "high",
  secretExport: "high",
  organizationDelete: "high",
} as const satisfies Record<string, RiskLevel>;
