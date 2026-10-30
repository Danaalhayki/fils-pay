import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { BadRequestError } from "../lib/errors.js";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Generates a short, human-readable invite code for admin user onboarding.
 *  The code is a bearer credential for an admin account, so it comes from the
 *  CSPRNG (32 symbols divides 256, so no modulo bias). */
export function generateInviteCode(length: number = 8): string {
  let code = "";
  for (const byte of randomBytes(length)) {
    code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return code;
}

export async function createAdminInvite(
  pool: Pool,
  input: { createdByAdminId: string; email: string; role: string; ttlHours: number },
): Promise<{ inviteId: string; code: string; expiresAt: Date }> {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);

  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_invites (created_by_admin_id, email, role, code, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.createdByAdminId, input.email, input.role, code, expiresAt],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createAdminInvite: insert returned no row");
  }
  return { inviteId: row.id, code, expiresAt };
}

export async function redeemAdminInvite(
  pool: Pool,
  input: { code: string; email: string },
): Promise<{ inviteId: string; role: string }> {
  const result = await pool.query<{ id: string; role: string }>(
    `UPDATE admin_invites
        SET redeemed_at = now()
      WHERE code = $1 AND email = $2 AND redeemed_at IS NULL AND expires_at > now()
     RETURNING id, role`,
    [input.code, input.email],
  );
  const row = result.rows[0];
  if (!row) {
    throw new BadRequestError("invalid_invite", "invite code is invalid, expired, or already used");
  }
  return { inviteId: row.id, role: row.role };
}
