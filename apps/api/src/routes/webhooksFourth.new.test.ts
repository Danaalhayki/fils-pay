/**
 * Fourth pass, webhooks: deleting an endpoint with history, disabled
 * endpoints, replaying an unfinished delivery, IPv6 transition addresses.
 * Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import { isPrivateAddress } from "../webhooks/egressGuard.js";
import type { WebhookTransport } from "../webhooks/transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("webhooksFourth.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKey(): Promise<{ merchantId: string; auth: { authorization: string } }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Webhooks p4 ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "p4" });
  return { merchantId, auth: { authorization: `Bearer ${issued.rawKey}` } };
}

async function endpointWithDelivery(
  merchantId: string,
  auth: { authorization: string },
  status: "pending" | "exhausted",
): Promise<{ endpointId: string; deliveryId: string; url: string }> {
  const url = `http://localhost:9/p4-${randomUUID()}`;
  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: auth,
    payload: { url },
  });
  assert.equal(created.statusCode, 201, created.body);
  const endpointId = (created.json() as { id: string }).id;

  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('transaction.voided', 'transaction', $1, $2) RETURNING id`,
    [randomUUID(), JSON.stringify({ merchantId })],
  );
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at)
     VALUES ($1, $2, 'transaction.voided', $3, '{}'::jsonb, $4, now() - interval '1 minute') RETURNING id`,
    [endpointId, outbox.rows[0]!.id, randomUUID(), status],
  );
  return { endpointId, deliveryId: delivery.rows[0]!.id, url };
}

test("deleting an endpoint that has deliveries succeeds, hides it, and keeps the history", async () => {
  const { merchantId, auth } = await merchantWithKey();
  const { endpointId, deliveryId } = await endpointWithDelivery(merchantId, auth, "exhausted");

  const del = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}`,
    headers: auth,
  });
  assert.equal(del.statusCode, 204, del.body);

  const list = await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/webhook-endpoints`, headers: auth });
  assert.deepEqual(list.json(), []);
  const kept = await pool.query(`SELECT 1 FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
  assert.equal(kept.rowCount, 1);

  const again = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}`,
    headers: auth,
  });
  assert.equal(again.statusCode, 404, again.body);
});

test("a disabled endpoint's pending deliveries are not sent", async () => {
  const { merchantId, auth } = await merchantWithKey();
  const { endpointId, deliveryId, url } = await endpointWithDelivery(merchantId, auth, "pending");
  const disable = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}`,
    headers: auth,
    payload: { status: "disabled" },
  });
  assert.equal(disable.statusCode, 200, disable.body);

  const sentTo: string[] = [];
  const transport: WebhookTransport = async (req) => {
    sentTo.push(req.url);
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(pool, transport, config);

  assert.ok(!sentTo.includes(url), "delivery sent to a disabled endpoint");
  const row = await pool.query<{ attempt_count: number; status: string }>(
    `SELECT attempt_count, status FROM webhook_deliveries WHERE id = $1`,
    [deliveryId],
  );
  assert.equal(row.rows[0]!.attempt_count, 0);
  assert.equal(row.rows[0]!.status, "pending");
});

test("a delivery still being retried cannot be replayed", async () => {
  const { merchantId, auth } = await merchantWithKey();
  const { endpointId, deliveryId } = await endpointWithDelivery(merchantId, auth, "pending");
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/replay`,
    headers: auth,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "delivery_not_finished");
});

test("IPv6 transition addresses that embed an internal IPv4 are refused", () => {
  for (const address of ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "::7f00:1", "2001:0:4136:e378::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("2606:4700::1111"), false);
});
