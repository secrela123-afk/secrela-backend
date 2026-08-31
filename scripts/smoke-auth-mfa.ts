/**
 * End-to-end smoke test against a running API (localhost:5005).
 * Marks email verified via MongoDB (test harness only — not production).
 *
 * Run: npx tsx scripts/smoke-auth-mfa.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Secret, TOTP } from "otpauth";

const API = process.env.SMOKE_API_URL ?? "http://localhost:5005";
const COOKIE = "sv_session";

type StepResult = { name: string; ok: boolean; detail?: string };

const results: StepResult[] = [];
let cookie = "";

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function grabCookie(res: Response) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    if (line.startsWith(`${COOKIE}=`)) {
      cookie = line.split(";")[0] ?? "";
      return;
    }
  }
  // Node fetch fallback
  const single = res.headers.get("set-cookie");
  if (single?.startsWith(`${COOKIE}=`)) {
    cookie = single.split(";")[0] ?? "";
  }
}

async function api(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${API}${path}`, { ...init, headers });
  grabCookie(res);
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, res };
}

function totpNow(secretBase32: string, email: string) {
  return new TOTP({
    issuer: process.env.APP_NAME ?? "Secrela",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

async function main() {
  const stamp = Date.now();
  const email = `smoke.${stamp}@example.com`;
  const password = "SmokeTest1!";
  const name = "Smoke Tester";

  console.log(`\nSmoke API: ${API}`);
  console.log(`User: ${email}\n`);

  // 0) Health
  {
    const { status, body } = await api("/health");
    record("0. Health", status === 200 && body?.ok === true, `status=${status}`);
  }

  // 1) Register
  {
    const { status, body } = await api("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, name, password }),
    });
    const ok =
      status === 201 &&
      body?.user?.email === email &&
      body?.mfaRequired === false &&
      Boolean(cookie);
    record("1. Register (user only, no org)", ok, `status=${status} cookie=${Boolean(cookie)}`);
    if (!ok) throw new Error("Register failed — abort");
  }

  // 2) Unverified login should fail
  {
    // clear cookie for clean login attempt
    const saved = cookie;
    cookie = "";
    const { status, body } = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    cookie = saved;
    const ok = status === 403 && body?.error?.code === "EMAIL_NOT_VERIFIED";
    record(
      "2. Login before verify → EMAIL_NOT_VERIFIED",
      ok,
      `status=${status} code=${body?.error?.code}`,
    );
  }

  // 3) Mark verified in DB (harness)
  {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI missing in backend/.env");
    await mongoose.connect(uri);
    const updated = await mongoose.connection.db
      ?.collection("users")
      .updateOne(
        { email },
        {
          $set: { emailVerified: true },
          $unset: {
            emailVerificationTokenHash: "",
            emailVerificationExpiresAt: "",
          },
        },
      );
    record(
      "3. Mark email verified (DB harness)",
      (updated?.modifiedCount ?? 0) > 0,
      `modified=${updated?.modifiedCount}`,
    );
  }

  // 4) Login without MFA → full session
  {
    cookie = "";
    const { status, body } = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const ok =
      status === 200 &&
      body?.mfaRequired === false &&
      body?.user?.emailVerified === true &&
      Boolean(cookie);
    record("4. Login MFA-off → full session", ok, `status=${status}`);
    if (!ok) throw new Error("Login failed — abort");
  }

  // 5) /me works; mfa disabled
  {
    const { status, body } = await api("/api/v1/auth/me");
    const ok =
      status === 200 &&
      body?.user?.mfaEnabled === false &&
      body?.session?.medium?.fresh === true &&
      body?.session?.high?.fresh === true;
    record(
      "5. GET /me dual freshness",
      ok,
      `medium=${body?.session?.medium?.fresh} high=${body?.session?.high?.fresh}`,
    );
  }

  // 6) Create org
  {
    const { status, body } = await api("/api/v1/organizations", {
      method: "POST",
      body: JSON.stringify({
        name: `Smoke Org ${stamp}`,
        type: "startup",
        phone: "+15550100",
      }),
    });
    record(
      "6. Create organization",
      status === 201 && Boolean(body?.organization?.id),
      `status=${status}`,
    );
  }

  // 7) MFA status
  {
    const { status, body } = await api("/api/v1/auth/mfa/status");
    record(
      "7. MFA status disabled",
      status === 200 && body?.mfa?.enabled === false,
      `enabled=${body?.mfa?.enabled}`,
    );
  }

  // 8) MFA setup (MEDIUM — should work while fresh)
  let totpSecret = "";
  {
    const { status, body } = await api("/api/v1/auth/mfa/setup", {
      method: "POST",
    });
    totpSecret = body?.secret ?? "";
    const ok =
      status === 200 &&
      typeof body?.otpauthUri === "string" &&
      body.otpauthUri.startsWith("otpauth://") &&
      Boolean(totpSecret);
    record("8. MFA setup → secret + otpauth URI", ok, `status=${status}`);
    if (!ok) throw new Error("MFA setup failed — abort");
  }

  // 9) Enable with wrong code
  {
    const { status, body } = await api("/api/v1/auth/mfa/enable", {
      method: "POST",
      body: JSON.stringify({ code: "000000" }),
    });
    record(
      "9. MFA enable wrong TOTP → rejected",
      status === 401 && body?.error?.code === "INVALID_MFA_CODE",
      `code=${body?.error?.code}`,
    );
  }

  // 10) Enable with valid TOTP
  let recoveryCodes: string[] = [];
  {
    const code = totpNow(totpSecret, email);
    const { status, body } = await api("/api/v1/auth/mfa/enable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    recoveryCodes = body?.recoveryCodes ?? [];
    const ok =
      status === 200 &&
      body?.user?.mfaEnabled === true &&
      recoveryCodes.length === 8;
    record(
      "10. MFA enable valid TOTP + recovery codes once",
      ok,
      `codes=${recoveryCodes.length}`,
    );
    if (!ok) throw new Error("MFA enable failed — abort");
  }

  // 11) DB: TOTP encrypted, recovery hashed only
  {
    const user = await mongoose.connection.db?.collection("users").findOne(
      { email },
      {
        projection: {
          mfaEnabled: 1,
          totpSecretEnc: 1,
          totpPendingSecretEnc: 1,
          recoveryCodeHashes: 1,
        },
      },
    );
    const enc = user?.totpSecretEnc as
      | { v?: number; iv?: string; tag?: string; ct?: string }
      | null
      | undefined;
    const hashes = (user?.recoveryCodeHashes as string[] | undefined) ?? [];
    const noPlainTotp =
      Boolean(enc?.iv && enc?.tag && enc?.ct) &&
      !JSON.stringify(enc).includes(totpSecret);
    const noPlainRecovery = recoveryCodes.every(
      (c) => !hashes.includes(c) && !JSON.stringify(hashes).includes(c),
    );
    record(
      "11. DB: TOTP encrypted, recovery hashes only",
      user?.mfaEnabled === true &&
        noPlainTotp &&
        noPlainRecovery &&
        hashes.length === 8 &&
        user?.totpPendingSecretEnc == null,
      `hashes=${hashes.length}`,
    );
  }

  // 12) Login with MFA → mfa_pending
  {
    cookie = "";
    const { status, body } = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    record(
      "12. Login MFA-on → mfa_pending",
      status === 200 && body?.mfaRequired === true && Boolean(cookie),
      `mfaRequired=${body?.mfaRequired}`,
    );
  }

  // 13) /me blocked while pending
  {
    const { status, body } = await api("/api/v1/auth/me");
    record(
      "13. /me during mfa_pending → MFA_REQUIRED",
      status === 401 && body?.error?.code === "MFA_REQUIRED",
      `code=${body?.error?.code}`,
    );
  }

  // 14) Wrong TOTP on verify
  {
    const { status, body } = await api("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ code: "000000" }),
    });
    record(
      "14. MFA verify wrong code → rejected",
      status === 401 && body?.error?.code === "INVALID_MFA_CODE",
      `code=${body?.error?.code}`,
    );
  }

  // Re-login pending (wrong verify may have left pending; get fresh pending)
  {
    cookie = "";
    await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  // 15) Valid TOTP → full
  {
    const code = totpNow(totpSecret, email);
    const { status, body } = await api("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    record(
      "15. MFA verify valid TOTP → full session",
      status === 200 && body?.mfaRequired === false && Boolean(cookie),
      `status=${status}`,
    );
  }

  // 16) Recovery code login (one-time)
  const recovery = recoveryCodes[0]!;
  {
    cookie = "";
    await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const { status, body } = await api("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ code: recovery }),
    });
    record(
      "16. MFA verify recovery code → full",
      status === 200 && body?.mfaRequired === false,
      `status=${status}`,
    );
  }

  // 17) Same recovery code again → reject
  {
    cookie = "";
    await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const { status, body } = await api("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ code: recovery }),
    });
    record(
      "17. Same recovery code second use → rejected",
      status === 401 && body?.error?.code === "INVALID_MFA_CODE",
      `code=${body?.error?.code}`,
    );
  }

  // Full login again for reauth tests
  {
    cookie = "";
    await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const code = totpNow(totpSecret, email);
    await api("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  // 18) Stale medium → REAUTH_REQUIRED
  {
    const session = await mongoose.connection.db
      ?.collection("sessions")
      .find({ revokedAt: null })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (session?._id) {
      await mongoose.connection.db?.collection("sessions").updateOne(
        { _id: session._id },
        {
          $set: {
            authFreshAt: new Date(Date.now() - 60 * 60_000),
            authHighFreshAt: new Date(Date.now() - 60 * 60_000),
          },
        },
      );
    }
    const { status, body } = await api("/api/v1/auth/mfa/setup", {
      method: "POST",
    });
    // MFA already enabled → might be MFA_ALREADY_ENABLED if fresh; we need stale path.
    // Use regenerate which is HIGH, or setup when already enabled returns 409 if fresh.
    // Better: call a HIGH endpoint — regenerate needs code. Use logout-all for HIGH stale.
    const high = await api("/api/v1/auth/logout-all", { method: "POST" });
    record(
      "18. Stale HIGH → REAUTH_REQUIRED",
      high.status === 403 && high.body?.error?.code === "REAUTH_REQUIRED",
      `code=${high.body?.error?.code} level=${high.body?.error?.details?.level} mfaRequired=${high.body?.error?.details?.mfaRequired}`,
    );
    // Also confirm medium on setup when already enabled isn't our focus; keep setup attempt logged lightly
    void status;
    void body;
  }

  // 19) Medium reauth = password only (no TOTP)
  {
    const { status, body } = await api("/api/v1/auth/reauthenticate", {
      method: "POST",
      body: JSON.stringify({ password, level: "medium" }),
    });
    record(
      "19. Reauth MEDIUM password-only",
      status === 200 &&
        body?.session?.medium?.fresh === true,
      `medium=${body?.session?.medium?.fresh} high=${body?.session?.high?.fresh}`,
    );
  }

  // High still stale after medium-only
  {
    const high = await api("/api/v1/auth/logout-all", { method: "POST" });
    record(
      "20. After MEDIUM reauth, HIGH still blocked",
      high.status === 403 && high.body?.error?.code === "REAUTH_REQUIRED",
      `level=${high.body?.error?.details?.level}`,
    );
  }

  // 21) Wrong password reauth
  {
    const { status, body } = await api("/api/v1/auth/reauthenticate", {
      method: "POST",
      body: JSON.stringify({
        password: "WrongPass1!",
        code: totpNow(totpSecret, email),
        level: "high",
      }),
    });
    record(
      "21. HIGH reauth wrong password → REAUTH_FAILED",
      status === 401 && body?.error?.code === "REAUTH_FAILED",
      `code=${body?.error?.code}`,
    );
  }

  // 22) HIGH reauth password + TOTP
  {
    const code = totpNow(totpSecret, email);
    const { status, body } = await api("/api/v1/auth/reauthenticate", {
      method: "POST",
      body: JSON.stringify({ password, code, level: "high" }),
    });
    record(
      "22. HIGH reauth password + TOTP",
      status === 200 &&
        body?.session?.medium?.fresh === true &&
        body?.session?.high?.fresh === true,
      `medium=${body?.session?.medium?.fresh} high=${body?.session?.high?.fresh}`,
    );
  }

  // 23) HIGH action allowed when fresh
  {
    const code = totpNow(totpSecret, email);
    // regenerate recovery — needs high fresh + TOTP in body
    const { status, body } = await api(
      "/api/v1/auth/mfa/recovery/regenerate",
      {
        method: "POST",
        body: JSON.stringify({ code }),
      },
    );
    const ok = status === 200 && Array.isArray(body?.recoveryCodes);
    if (ok) recoveryCodes = body.recoveryCodes;
    record(
      "23. HIGH regenerate recovery codes",
      ok,
      `status=${status} count=${body?.recoveryCodes?.length}`,
    );
  }

  // 24) Disable MFA (HIGH)
  {
    const code = totpNow(totpSecret, email);
    const { status, body } = await api("/api/v1/auth/mfa/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    record(
      "24. Disable MFA",
      status === 200 && body?.user?.mfaEnabled === false,
      `mfaEnabled=${body?.user?.mfaEnabled}`,
    );
  }

  // 25) Login after disable → no MFA challenge
  {
    cookie = "";
    const { status, body } = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    record(
      "25. Login after MFA disabled → full (no challenge)",
      status === 200 && body?.mfaRequired === false,
      `mfaRequired=${body?.mfaRequired}`,
    );
  }

  // 26) Session token not stored plaintext
  {
    const sessions = await mongoose.connection.db
      ?.collection("sessions")
      .find({})
      .project({ tokenHash: 1 })
      .limit(5)
      .toArray();
    const cookieValue = cookie.split("=")[1] ?? "";
    const ok = (sessions ?? []).every(
      (s) => s.tokenHash && s.tokenHash !== cookieValue,
    );
    record("26. Session DB stores hash not raw cookie", ok);
  }

  await mongoose.disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n——— Summary: ${results.length - failed.length}/${results.length} PASS ——-\n`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("\nSmoke aborted:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
