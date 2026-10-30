import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Pool } from "pg";

export interface OverloadLimits {
  /** Requests being handled at once. */
  maxInFlight: number;
  /** Queries queued for a pool connection. */
  maxDbWaiting: number;
  /** Mean event-loop delay over the last sample window, ms. */
  maxEventLoopDelayMs: number;
}

export interface OverloadPluginOptions {
  pool: Pick<Pool, "waitingCount">;
  limits: OverloadLimits;
  sampleIntervalMs?: number;
}

export type OverloadReason = "in_flight" | "db_queue" | "event_loop";

/** Liveness and readiness must keep answering while the API sheds load, or
 *  the container watchdog would restart a process that is merely busy. */
const EXEMPT_PATHS = new Set(["/healthz", "/readyz"]);

const counted = new WeakSet<FastifyRequest>();

export function overloadReason(
  state: { inFlight: number; dbWaiting: number; eventLoopDelayMs: number },
  limits: OverloadLimits,
): OverloadReason | null {
  if (limits.maxInFlight > 0 && state.inFlight >= limits.maxInFlight) return "in_flight";
  if (limits.maxDbWaiting > 0 && state.dbWaiting >= limits.maxDbWaiting) return "db_queue";
  if (limits.maxEventLoopDelayMs > 0 && state.eventLoopDelayMs > limits.maxEventLoopDelayMs) return "event_loop";
  return null;
}

/**
 * Load shedding. A request turned away here has done no work, so the client
 * can retry it unchanged (same Idempotency-Key). Queueing it instead would
 * only slow every request down until all of them time out.
 */
export const overloadPlugin = fp(async (app: FastifyInstance, options: OverloadPluginOptions): Promise<void> => {
  const { pool, limits } = options;
  let inFlight = 0;
  let eventLoopDelayMs = 0;
  let shed = 0;

  const histogram = limits.maxEventLoopDelayMs > 0 ? monitorEventLoopDelay({ resolution: 20 }) : null;
  let sampler: NodeJS.Timeout | null = null;
  if (histogram) {
    histogram.enable();
    sampler = setInterval(() => {
      eventLoopDelayMs = histogram.mean / 1e6;
      histogram.reset();
      if (shed > 0) {
        app.log.warn({ shed, inFlight, dbWaiting: pool.waitingCount, eventLoopDelayMs }, "overload: shed requests");
        shed = 0;
      }
    }, options.sampleIntervalMs ?? 1_000);
    sampler.unref();
  }

  app.addHook("onClose", async () => {
    if (sampler) clearInterval(sampler);
    histogram?.disable();
  });

  const release = (request: FastifyRequest): void => {
    if (counted.delete(request)) inFlight -= 1;
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (EXEMPT_PATHS.has(path)) return;

    const reason = overloadReason({ inFlight, dbWaiting: pool.waitingCount, eventLoopDelayMs }, limits);
    if (reason) {
      shed += 1;
      reply
        .code(503)
        .header("Retry-After", "1")
        .header("Cache-Control", "no-store")
        .send({ error: "overloaded", message: "Server is busy, retry shortly", reason });
      return reply;
    }
    counted.add(request);
    inFlight += 1;
  });

  app.addHook("onResponse", async (request) => release(request));
  app.addHook("onRequestAbort", async (request) => release(request));
});
