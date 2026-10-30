import type { Pool, PoolClient } from "pg";

/**
 * Checks out a client from `pool`, runs `fn` inside a `BEGIN`/`COMMIT`
 * transaction, and rolls back on any error — always releasing the client
 * back to the pool. This is the standard way to perform a multi-statement
 * atomic write (e.g. signup, KYC review recording) anywhere in this
 * codebase; a bare pool query is only for single-statement reads/writes
 * that don't need atomicity with anything else.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  /*
   * Isolation level is the Postgres default (READ COMMITTED). Callers that
   * need to serialise on a row take an explicit SELECT ... FOR UPDATE inside
   * fn; nothing here upgrades the level.
   */
  const client = await pool.connect();
  // A client whose ROLLBACK failed is in an unknown state: release(err)
  // makes pg destroy it instead of handing it to the next caller.
  let brokenClient: Error | undefined;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        brokenClient = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    }
  } finally {
    client.release(brokenClient);
  }
}
