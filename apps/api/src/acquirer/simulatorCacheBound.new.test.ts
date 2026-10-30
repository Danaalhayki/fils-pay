import assert from "node:assert/strict";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createAcquirerSimulator } from "./simulator.js";

const card = { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function authorize(sim: ReturnType<typeof createAcquirerSimulator>, key: string) {
  return sim.authorize({ merchantId: "m1", amountFils: toFils(1000), currency: "BHD", card, idempotencyKey: key });
}

test("simulator idempotency cache is bounded: the oldest key is dropped, recent keys still replay", async () => {
  const sim = createAcquirerSimulator({
    acquirerLatencyMinMs: 0,
    acquirerLatencyMaxMs: 0,
    acquirerFailureRate: 0,
    acquirerRngSeed: null,
    acquirerIdempotencyCacheSize: 2,
  });

  const a = await authorize(sim, "a");
  await authorize(sim, "b");
  const c = await authorize(sim, "c");

  assert.equal((await authorize(sim, "c")).acquirerReference, c.acquirerReference, "recent key replays");
  assert.notEqual(
    (await authorize(sim, "a")).acquirerReference,
    a.acquirerReference,
    "the oldest key was evicted instead of being kept forever",
  );
});
