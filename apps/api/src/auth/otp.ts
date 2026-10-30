import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { timingSafeEqualHex } from "../lib/crypto.js";
import { TooManyRequestsError } from "../lib/errors.js";
import { randomDigits } from "../lib/random.js";

/** e.g. generateOtpCode(6) => "042817". */
export function generateOtpCode(length: number): string {
  return randomDigits(length);
}

/**
 * Hashes an OTP code with its per-challenge salt. `code_salt` is a fresh
 * random value per challenge, so the stored `code_hash` is not a bare,
 * unsalted sha256 of a small code space (which would be trivially
 * rainbow-tabled). The raw code is never persisted; it exists only in
 * memory long enough to hash it and hand it to the notifier.
 */
export function hashOtpCode(code: string, salt: string): string {
  return createHash("sha256").update(salt + code).digest("hex");
}

/** Constant-time match of a user-supplied code against a stored challenge. */
export function verifyOtpCode(inputCode: string, salt: string, expectedHash: string): boolean {
  return timingSafeEqualHex(hashOtpCode(inputCode, salt), expectedHash);
}

/** Wrong codes allowed per user across all challenges in the window. */
export const OTP_FAILURES_PER_WINDOW = 10;
export const OTP_FAILURE_WINDOW_MINUTES = 15;

/**
 * Called before minting a challenge. `max_attempts` alone is per challenge,
 * and every login or resend mints a new one, so without this a caller who
 * knows the password gets unlimited guesses. Serializes on the user row,
 * refuses once the user's recent wrong codes reach the limit, and retires
 * any earlier unconsumed challenge so only the newest is guessable.
 */
export async function guardOtpIssuance(
  client: PoolClient,
  table: "otp_challenges" | "admin_otp_challenges",
  userColumn: "merchant_user_id" | "admin_user_id",
  userId: string,
): Promise<void> {
  const userTable = table === "otp_challenges" ? "merchant_users" : "admin_users";
  await client.query(`SELECT 1 FROM ${userTable} WHERE id = $1 FOR UPDATE`, [userId]);
  const recent = await client.query<{ failures: string }>(
    `SELECT COALESCE(SUM(attempt_count) - COUNT(*) FILTER (WHERE consumed_at IS NOT NULL), 0)::text AS failures
       FROM ${table}
      WHERE ${userColumn} = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [userId, OTP_FAILURE_WINDOW_MINUTES],
  );
  if (Number(recent.rows[0]?.failures ?? 0) >= OTP_FAILURES_PER_WINDOW) {
    throw new TooManyRequestsError("too_many_attempts", "too many wrong codes; try again later");
  }
  await client.query(
    `UPDATE ${table} SET expires_at = LEAST(expires_at, now())
      WHERE ${userColumn} = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [userId],
  );
}

export interface IssuedOtpChallenge {
  id: string;
  code: string;
  expiresAt: Date;
}

/**
 * Inserts a fresh `otp_challenges` row inside the caller's open transaction
 * and returns the raw code (never stored) so the caller can hand it to the
 * notifier / dev-expose response field.
 */
export async function issueChallenge(
  client: PoolClient,
  params: { merchantUserId: string; ttlMinutes: number; codeLength: number; maxAttempts: number },
): Promise<IssuedOtpChallenge> {
  await guardOtpIssuance(client, "otp_challenges", "merchant_user_id", params.merchantUserId);
  const code = generateOtpCode(params.codeLength);
  const salt = randomBytes(16).toString("hex");
  const hash = hashOtpCode(code, salt);
  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60_000);

  const result = await client.query<{ id: string }>(
    `INSERT INTO otp_challenges (merchant_user_id, code_salt, code_hash, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.merchantUserId, salt, hash, expiresAt, params.maxAttempts],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("issueChallenge: insert into otp_challenges returned no row");
  }
  return { id: row.id, code, expiresAt };
}
