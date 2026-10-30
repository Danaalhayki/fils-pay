import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { overloadPlugin, overloadReason, type OverloadLimits } from "./overload.js";
import { errorHandler } from "./errorHandler.js";

const OFF: OverloadLimits = { maxInFlight: 0, maxDbWaiting: 0, maxEventLoopDelayMs: 0 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("overloadReason: each limit trips on its own and 0 disables it", () => {
  const idle = { inFlight: 0, dbWaiting: 0, eventLoopDelayMs: 0 };
  assert.equal(overloadReason(idle, { maxInFlight: 1, maxDbWaiting: 1, maxEventLoopDelayMs: 1 }), null);
  assert.equal(overloadReason({ ...idle, inFlight: 3 }, { ...OFF, maxInFlight: 3 }), "in_flight");
  assert.equal(overloadReason({ ...idle, dbWaiting: 4 }, { ...OFF, maxDbWaiting: 4 }), "db_queue");
  assert.equal(overloadReason({ ...idle, eventLoopDelayMs: 900 }, { ...OFF, maxEventLoopDelayMs: 500 }), "event_loop");
  assert.equal(overloadReason({ inFlight: 1e6, dbWaiting: 1e6, eventLoopDelayMs: 1e6 }, OFF), null);
});

test("past maxInFlight the API answers 503 + Retry-After at once, and recovers when load drops", async () => {
  const app = Fastify();
  app.register(overloadPlugin, { pool: { waitingCount: 0 }, limits: { ...OFF, maxInFlight: 2 } });
  const gate = deferred();
  let handled = 0;
  app.get("/slow", async () => {
    handled += 1;
    await gate.promise;
    return { ok: true };
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  await app.ready();

  const first = app.inject({ method: "GET", url: "/slow" });
  const second = app.inject({ method: "GET", url: "/slow" });
  while (handled < 2) await new Promise((r) => setImmediate(r));

  const shed = await app.inject({ method: "GET", url: "/slow" });
  assert.equal(shed.statusCode, 503);
  assert.equal(shed.headers["retry-after"], "1");
  assert.equal(shed.json().error, "overloaded");
  assert.equal(shed.json().reason, "in_flight");
  assert.equal(handled, 2, "a shed request must never reach the handler");

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200, "liveness keeps answering while shedding");

  gate.resolve();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);

  const after = await app.inject({ method: "GET", url: "/slow" });
  assert.equal(after.statusCode, 200, "in-flight count is released after each response");
  await app.close();
});

test("a queue for database connections sheds new requests", async () => {
  const pool = { waitingCount: 0 };
  const app = Fastify();
  app.register(overloadPlugin, { pool, limits: { ...OFF, maxDbWaiting: 5 } });
  app.get("/x", async () => ({ ok: true }));
  await app.ready();

  assert.equal((await app.inject({ method: "GET", url: "/x" })).statusCode, 200);
  pool.waitingCount = 5;
  const shed = await app.inject({ method: "GET", url: "/x" });
  assert.equal(shed.statusCode, 503);
  assert.equal(shed.json().reason, "db_queue");
  pool.waitingCount = 0;
  assert.equal((await app.inject({ method: "GET", url: "/x" })).statusCode, 200);
  await app.close();
});

test("a pg pool connection timeout is a retryable 503, not a 500", async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get("/x", async () => {
    throw new Error("timeout exceeded when trying to connect");
  });
  const res = await app.inject({ method: "GET", url: "/x" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "1");
  assert.equal(res.json().error, "overloaded");
  await app.close();
});
