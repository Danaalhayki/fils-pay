import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRow } from "./replay.js";

const ARCHIVE_PAGE_SIZE = 1000;

export interface ArchivedDeliveryEntry {
  deliveryId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateArchiveResult {
  archiveId: string;
  deliveryCount: number;
}

/**
 * Snapshots every delivery for one endpoint in [from, to) into a single
 * retained row, ahead of a URL rotation or the endpoint being disabled. No
 * row cap: an audit archive that silently dropped deliveries past some
 * threshold would defeat the reason it exists (a receiver's own support
 * team, or a future auditor, needs the *complete* record for the range they
 * were told the archive covers).
 */
export async function createWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; endpointId: string; adminUserId: string; from: Date; to: Date },
): Promise<CreateArchiveResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
      [input.endpointId, input.merchantId],
    );
    if (!endpoint.rows[0]) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }

    // Built entirely inside Postgres: a year of deliveries never passes
    // through this (512 MB) process.
    const inserted = await client.query<{ id: string; delivery_count: number }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       SELECT $1, $2, $3, $4, $5, count(*),
              COALESCE(
                json_agg(json_build_object(
                  'deliveryId', wd.id::text,
                  'outboxEventId', wd.outbox_event_id::text,
                  'eventType', wd.event_type,
                  'payload', wd.payload,
                  'createdAt', to_char(wd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) ORDER BY wd.created_at, wd.id),
                '[]'
              )::text
         FROM webhook_deliveries wd
        WHERE wd.endpoint_id = $1 AND wd.created_at >= $4 AND wd.created_at < $5
       RETURNING id, delivery_count`,
      [input.endpointId, input.merchantId, input.adminUserId, input.from, input.to],
    );
    const archive = inserted.rows[0]!;

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount: archive.delivery_count },
    });

    return { archiveId: archive.id, deliveryCount: archive.delivery_count };
  });
}

/**
 * Bulk-replays every delivery captured in a previously created archive —
 * used to backfill a newly registered replacement endpoint with a
 * merchant's delivery history after a URL rotation, without asking the
 * merchant to re-trigger months of real events. Entries are read back
 * through a server-side cursor in pages of ARCHIVE_PAGE_SIZE, never parsed
 * as one document in this process.
 */
export async function pruneExpiredArchives(
  pool: Pool,
  retentionDays: number,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await pool.query(
    `DELETE FROM webhook_delivery_archives
      WHERE created_at < $1
        AND created_by_admin_user_id IS NOT NULL
    RETURNING id`,
    [cutoff],
  );
  return { deletedCount: result.rowCount ?? 0 };
}

export async function replayWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; archiveId: string; targetEndpointId: string; adminUserId: string },
): Promise<{ replayedCount: number }> {
  return withTransaction(pool, async (client) => {
    const archiveResult = await client.query<{ id: string }>(
      `SELECT id FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
      [input.archiveId, input.merchantId],
    );
    if (!archiveResult.rows[0]) {
      throw new NotFoundError("webhook_delivery_archive_not_found");
    }

    const targetEndpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
      [input.targetEndpointId, input.merchantId],
    );
    const targetRow = targetEndpoint.rows[0];
    if (!targetRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    await client.query(
      `DECLARE archive_entries NO SCROLL CURSOR FOR
         SELECT e.value AS entry
           FROM webhook_delivery_archives a,
                json_array_elements(a.archive_payload::json) WITH ORDINALITY AS e(value, n)
          WHERE a.id = $1
          ORDER BY e.n`,
      [input.archiveId],
    );
    let replayedCount = 0;
    for (;;) {
      const page = await client.query<{ entry: ArchivedDeliveryEntry }>(
        `FETCH ${ARCHIVE_PAGE_SIZE} FROM archive_entries`,
      );
      for (const { entry } of page.rows) {
        await insertReplayDeliveryRow(client, {
          id: entry.deliveryId,
          endpointId: input.targetEndpointId,
          outboxEventId: entry.outboxEventId,
          eventType: entry.eventType,
          payload: entry.payload,
        });
        replayedCount++;
      }
      if (page.rows.length < ARCHIVE_PAGE_SIZE) break;
    }
    await client.query(`CLOSE archive_entries`);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_replay",
      targetType: "webhook_endpoint",
      targetId: input.targetEndpointId,
      metadata: { merchantId: input.merchantId, archiveId: input.archiveId, replayedCount },
    });

    return { replayedCount };
  });
}
