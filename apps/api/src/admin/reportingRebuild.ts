import type { PoolClient } from "pg";

/** Rows cleared from each rollup table; apps/reporting replays them. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/**
 * Truncates the two rollup tables (merchant_daily_volume,
 * merchant_payout_trends) and resets the reporting consumer's watermark in
 * the same transaction, so apps/reporting replays the whole outbox through
 * its one applyEvent path — same as `reporting rebuild`.
 *
 * Refilling the tables here from source while leaving the watermark where it
 * was let the worker re-apply every not-yet-consumed event on top (double
 * counting), and was a second implementation that had already drifted (it
 * copied 'open' batches and had no refund columns).
 */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // Taking the cursor row first waits out any in-flight consumer pass.
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, last_tx_id, updated_at)
     VALUES ('reporting', 0, '0', now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, last_tx_id = '0', updated_at = now()`,
  );

  const counts = await client.query<{ volume: string; trend: string }>(
    `SELECT (SELECT count(*) FROM merchant_daily_volume)::text AS volume,
            (SELECT count(*) FROM merchant_payout_trends)::text AS trend`,
  );
  await client.query(`TRUNCATE merchant_daily_volume, merchant_payout_trends`);

  return { volumeRows: Number(counts.rows[0]?.volume ?? 0), trendRows: Number(counts.rows[0]?.trend ?? 0) };
}
