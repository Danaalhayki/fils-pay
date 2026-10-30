/**
 * Third audit pass: malformed signup bodies and webhook-endpoint updates are
 * client errors (400), not database CHECK violations surfacing as 500.
 * Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { updateWebhookEndpoint } from "../webhooks/update.js";
import { BadRequestError } from "../lib/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("thirdPass.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function signupBody(overrides: { businessProfile?: Record<string, unknown>; owner?: Record<string, unknown> } = {}) {
  return {
    businessProfile: {
      legalName: `Third pass ${randomUUID()}`,
      registrationNumber: "CR-1",
      businessType: "llc",
      contactEmail: "ops@example.test",
      contactPhone: "+97300000000",
      addressLine1: "Road 1",
      city: "Manama",
      ...overrides.businessProfile,
    },
    owner: { email: `owner-${randomUUID()}@example.test`, password: "correct horse battery", ...overrides.owner },
  };
}

test("signup rejects an unknown businessType and non-string fields with 400", async () => {
  for (const payload of [
    signupBody({ businessProfile: { businessType: "corporation" } }),
    signupBody({ owner: { password: 12345678 } }),
    signupBody({ businessProfile: { postalCode: 123 } }),
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/merchants", payload });
    assert.equal(res.statusCode, 400, res.body);
  }

  const ok = await app.inject({ method: "POST", url: "/v1/merchants", payload: signupBody() });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("webhook endpoint update rejects an unknown status before touching the database", async () => {
  await assert.rejects(
    updateWebhookEndpoint(pool, config, {
      merchantId: randomUUID(),
      id: randomUUID(),
      status: "paused" as unknown as "active",
    }),
    (err: unknown) => err instanceof BadRequestError,
  );
});
