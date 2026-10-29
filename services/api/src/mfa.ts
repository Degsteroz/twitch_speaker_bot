// The second factor (TOTP and recovery codes): setup, confirmation and the lockout.
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { issueSession } from "./auth.js";
import { denied, session, type RouteContext } from "./context.js";
import { decryptValue, encryptValue } from "./security.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp
} from "./totp.js";

const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
const mfaCodeSchema = z.object({ code: z.string().trim().min(6).max(32) });

type FactorCheck =
  | { ok: true; via: "totp" | "recovery" }
  | { ok: false; status: number; code: string; message: string };

interface FactorRow {
  ciphertext: string | null;
  iv: string | null;
  tag: string | null;
  lastStep: number | null;
  recoveryHashes: string[];
  failures: number;
  lockedUntil: Date | null;
}

interface MfaState {
  login: string;
  role: string;
  status: string;
  enabled: boolean;
  started: boolean;
}

export function registerMfaRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, config, requireSession, requireUser, audit } = context;

  // Checks a TOTP or recovery code under a row lock, so parallel guesses all count toward the
  // lockout. Failures are committed even though the caller answers with an error.
  const checkSecondFactor = (userId: string, rawCode: string) =>
    sql.begin(async (tx): Promise<FactorCheck> => {
      const [row] = await tx<FactorRow[]>`
        select totp_secret_ciphertext ciphertext, totp_secret_iv iv, totp_secret_tag tag,
          totp_last_step::float8 "lastStep", mfa_recovery_hashes "recoveryHashes",
          mfa_failed_attempts failures, mfa_locked_until "lockedUntil"
        from users where id=${userId} for update`;
      if (!row?.ciphertext || !row.iv || !row.tag) {
        return { ok: false, status: 409, code: "mfa_not_configured", message: "2FA не настроена" };
      }
      if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
        return {
          ok: false,
          status: 429,
          code: "mfa_locked",
          message: `Слишком много неверных кодов. Повторите через ${String(minutes)} мин.`
        };
      }
      const code = rawCode.replace(/\s/gu, "");
      const secret = decryptValue(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
        config.TOKEN_ENCRYPTION_KEY
      );
      const step = verifyTotp(secret, code, row.lastStep);
      if (step !== null) {
        await tx`update users set totp_last_step=${step}, mfa_failed_attempts=0,
          mfa_locked_until=null where id=${userId}`;
        return { ok: true, via: "totp" };
      }
      const hash = hashRecoveryCode(code);
      if (normalizeRecoveryCode(code).length === 10 && row.recoveryHashes.includes(hash)) {
        await tx`update users set mfa_recovery_hashes=array_remove(mfa_recovery_hashes, ${hash}),
          mfa_failed_attempts=0, mfa_locked_until=null where id=${userId}`;
        return { ok: true, via: "recovery" };
      }
      const failures = row.failures + 1;
      const lock = failures >= MFA_MAX_FAILURES;
      await tx`update users set mfa_failed_attempts=${lock ? 0 : failures},
        mfa_locked_until=${lock ? new Date(Date.now() + MFA_LOCK_MS) : null} where id=${userId}`;
      return lock
        ? {
            ok: false,
            status: 429,
            code: "mfa_locked",
            message: "Слишком много неверных кодов. Вход по 2FA заблокирован на 15 минут."
          }
        : { ok: false, status: 400, code: "mfa_invalid", message: "Неверный код" };
    });

  const mfaState = async (userId: string) => {
    const [row] = await sql<MfaState[]>`
      select login, role, status, totp_enabled_at is not null enabled,
        totp_secret_ciphertext is not null started from users where id=${userId}`;
    return row;
  };

  app.post("/me/mfa/setup", { preHandler: requireSession }, async (request, reply) => {
    const { userId } = session(request);
    const state = await mfaState(userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (state.status === "pending") {
      return denied(reply, 403, "pending_approval", "Заявка ещё не одобрена владельцем");
    }
    if (state.enabled) return denied(reply, 409, "mfa_already_enabled", "2FA уже включена");
    const secret = generateTotpSecret();
    const encrypted = encryptValue(secret, config.TOKEN_ENCRYPTION_KEY);
    await sql`update users set totp_secret_ciphertext=${encrypted.ciphertext},
      totp_secret_iv=${encrypted.iv}, totp_secret_tag=${encrypted.tag}, totp_last_step=null
      where id=${userId} and totp_enabled_at is null`;
    return { secret, otpauthUri: otpauthUri(secret, state.login) };
  });

  app.post("/me/mfa/enable", { preHandler: requireSession }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (state.status === "pending") {
      return denied(reply, 403, "pending_approval", "Заявка ещё не одобрена владельцем");
    }
    if (state.enabled) return denied(reply, 409, "mfa_already_enabled", "2FA уже включена");
    if (!state.started)
      return denied(reply, 409, "mfa_setup_required", "Сначала начните настройку");
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    const recoveryCodes = generateRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`update users set totp_enabled_at=now(),
        mfa_recovery_hashes=${recoveryCodes.map(hashRecoveryCode)} where id=${claims.userId}`;
      await audit(tx, request, "mfa.enable", claims.userId, {});
    });
    await issueSession(reply, { ...claims, mfaAt: Date.now() }, config);
    return { recoveryCodes };
  });

  app.post("/me/mfa/verify", { preHandler: requireSession }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (!state.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    if (result.via === "recovery") {
      await sql.begin((tx) => audit(tx, request, "mfa.recovery_code_used", claims.userId, {}));
    }
    await issueSession(reply, { ...claims, mfaAt: Date.now() }, config);
    const [left] = await sql<{ count: number }[]>`
      select cardinality(mfa_recovery_hashes)::int count from users where id=${claims.userId}`;
    return { ok: true, via: result.via, recoveryCodesLeft: left?.count ?? 0 };
  });

  app.post("/me/mfa/recovery-codes", { preHandler: requireUser }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const { userId } = session(request);
    const state = await mfaState(userId);
    if (!state?.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    const result = await checkSecondFactor(userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    const recoveryCodes = generateRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`update users set mfa_recovery_hashes=${recoveryCodes.map(hashRecoveryCode)}
        where id=${userId}`;
      await audit(tx, request, "mfa.recovery_codes_regenerated", userId, {});
    });
    return { recoveryCodes };
  });

  app.post("/me/mfa/disable", { preHandler: requireUser }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state?.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    if (state.role === "owner") {
      return denied(reply, 403, "mfa_mandatory", "Владельцу сервиса 2FA отключать нельзя");
    }
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    await sql.begin(async (tx) => {
      await tx`update users set totp_secret_ciphertext=null, totp_secret_iv=null,
        totp_secret_tag=null, totp_enabled_at=null, totp_last_step=null,
        mfa_recovery_hashes=ARRAY[]::text[] where id=${claims.userId}`;
      await audit(tx, request, "mfa.disable", claims.userId, {});
    });
    await issueSession(
      reply,
      { userId: claims.userId, channelId: claims.channelId, role: claims.role },
      config
    );
    return { ok: true };
  });
}
