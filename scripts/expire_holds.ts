#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits
 * 'active' past its expires_at forever (authorize.ts inserts one,
 * capture.ts/void.ts release one; nothing else sweeps one). Run once a night
 * from cron/the host's own scheduler.
 *
 * HANDOVER: flips `active` to `expired` with one UPDATE. Holds are never
 * deleted. A single statement also re-checks status at write time, so a hold
 * captured or released concurrently is never touched.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const EXPIRE_HOLDS_SQL = `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`;

export async function expireHolds(client: Pick<Client, "query">): Promise<number> {
  const result = await client.query(EXPIRE_HOLDS_SQL);
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expired = await expireHolds(client);
    console.log(`expire_holds: marked ${expired} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
