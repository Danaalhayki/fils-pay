import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at. The watermark is the pair
 * (writing transaction id, outbox id) of the last event applied (0078).
 */
export interface ConsumerCursor {
  lastProcessedId: bigint;
  /** xid8 as text. */
  lastTxId: string;
}

/**
 * last_processed_id is BIGINT; pg returns it as a string, hence the union.
 */
interface CursorRow {
  last_processed_id: string | number;
  last_tx_id: string;
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads and row-locks it. The lock is held until the caller's
 * transaction ends, so a catch-up/rebuild run beside the live worker (or a
 * second replica) waits instead of applying the same events twice.
 */
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_id, last_tx_id::text AS last_tx_id
       FROM reporting_outbox_cursor WHERE consumer_name = $1
        FOR UPDATE`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  return {
    lastProcessedId: row ? BigInt(row.last_processed_id) : 0n,
    lastTxId: row ? row.last_tx_id : "0",
  };
}

export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  newLastProcessedId: bigint,
  newLastTxId: string,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = $2, last_tx_id = $3::xid8, updated_at = now()
      WHERE consumer_name = $1`,
    [consumerName, newLastProcessedId.toString(), newLastTxId],
  );
}

/** Resets this consumer's watermark to the start — used by the `rebuild`
 *  subcommand (cli/rebuild.ts) and the admin analytics rebuild before
 *  replaying the entire outbox history. */
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, last_tx_id, updated_at)
     VALUES ($1, 0, '0', now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, last_tx_id = '0', updated_at = now()`,
    [consumerName],
  );
}
