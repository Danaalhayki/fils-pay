import { randomInt, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { createSeededRng } from "./rng.js";
import type {
  AcquirerAuthorizeRequest,
  AcquirerAuthorizeResult,
  AcquirerCaptureRequest,
  AcquirerCaptureResult,
  AcquirerOutcome,
  AcquirerRefundRequest,
  AcquirerRefundResult,
  AcquirerSimulator,
} from "./types.js";

const DECLINE_REASONS = ["do_not_honor", "insufficient_funds", "card_expired", "suspected_fraud"];

interface RandomSource {
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** Crypto-backed randomness, used when no deterministic seed is configured. */
function cryptoRandomSource(): RandomSource {
  return {
    int(min, max) {
      return randomInt(min, max + 1);
    },
    chance(probability) {
      const resolution = 1_000_000;
      const clamped = Math.max(0, Math.min(1, probability));
      return randomInt(0, resolution) < Math.round(clamped * resolution);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("cryptoRandomSource.pick: items must not be empty");
      }
      const idx = randomInt(0, items.length);
      return items[idx] as T;
    },
  };
}

/** Seeded, reproducible randomness — used when `config.acquirerRngSeed` is
 *  set, so a fixed seed plus a fixed sequence of calls reproduces
 *  byte-identical latency/outcome sequences. */
function seededRandomSource(seed: number): RandomSource {
  const rng = createSeededRng(seed);
  return {
    int(min, max) {
      return rng.int(min, max);
    },
    chance(probability) {
      return rng.next() < probability;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("seededRandomSource.pick: items must not be empty");
      }
      const idx = Math.floor(rng.next() * items.length);
      return items[Math.min(idx, items.length - 1)] as T;
    },
  };
}

/**
 * Only the simulator knobs from Config.
 * — MK
 */
type SimulatorConfig = Pick<
  Config,
  "acquirerLatencyMinMs" | "acquirerLatencyMaxMs" | "acquirerFailureRate" | "acquirerRngSeed"
> &
  Partial<Pick<Config, "acquirerIdempotencyCacheSize">>;

const DEFAULT_IDEMPOTENCY_CACHE_SIZE = 10_000;

/** Insert-ordered Map as a FIFO: once full, the oldest key is dropped. The
 *  durable idempotency record is the idempotency_keys table; this cache only
 *  has to cover a retry that arrives shortly after the first call. */
function remember<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/**
 * In-process simulated acquirer. Lives in `apps/api` rather than a separate
 * service: the load test only needs observable HTTP-boundary latency, which
 * an in-process `await sleep(ms)` produces identically to an out-of-process
 * call, at zero extra RAM/CPU cost — a meaningful saving under the 0.5 vCPU
 * / 512 MB budget for the whole platform.
 */
export function createAcquirerSimulator(config: SimulatorConfig): AcquirerSimulator {
  const random = config.acquirerRngSeed !== null ? seededRandomSource(config.acquirerRngSeed) : cryptoRandomSource();
  const maxCached = Math.max(1, config.acquirerIdempotencyCacheSize ?? DEFAULT_IDEMPOTENCY_CACHE_SIZE);

  // In-process idempotency caches, one per operation. A retried call with
  // the same idempotency key returns the cached result unchanged rather
  // than re-rolling latency/outcome, so a client retry after a timeout
  // gets a consistent acquirer response. In-memory and process-local: a
  // deliberate fit for this platform's single small container target, not
  // durable across a process restart or multiple replicas.
  const authorizeCache = new Map<string, AcquirerAuthorizeResult>();
  const captureCache = new Map<string, AcquirerCaptureResult>();
  const refundCache = new Map<string, AcquirerRefundResult>();

  async function applyLatency(): Promise<number> {
    const ms = random.int(config.acquirerLatencyMinMs, config.acquirerLatencyMaxMs);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return ms;
  }

  function rollOutcome(): { outcome: AcquirerOutcome; declineReason?: string } {
    if (!random.chance(config.acquirerFailureRate)) {
      return { outcome: "approved" };
    }
    if (random.chance(0.7)) {
      return { outcome: "declined", declineReason: random.pick(DECLINE_REASONS) };
    }
    return { outcome: "error" };
  }

  function magicOutcomeForPan(pan: string): { outcome: AcquirerOutcome; declineReason?: string } | null {
    if (pan.endsWith("0002")) return { outcome: "declined", declineReason: "do_not_honor" };
    if (pan.endsWith("0119")) return { outcome: "declined", declineReason: "insufficient_funds" };
    if (pan.endsWith("0069")) return { outcome: "error" };
    return null;
  }

  return {
    async authorize(req: AcquirerAuthorizeRequest): Promise<AcquirerAuthorizeResult> {
      const cached = authorizeCache.get(req.idempotencyKey);
      if (cached) return cached;

      // Deterministic magic test cards are checked first, independent of
      // the failure-rate roll.
      const rolled = magicOutcomeForPan(req.card.pan) ?? rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerAuthorizeResult = {
        outcome: rolled.outcome,
        acquirerReference: `acq_${randomUUID()}`,
        ...(rolled.declineReason !== undefined ? { declineReason: rolled.declineReason } : {}),
        latencyMs,
      };
      remember(authorizeCache, req.idempotencyKey, result, maxCached);
      return result;
    },

    async capture(req: AcquirerCaptureRequest): Promise<AcquirerCaptureResult> {
      const cached = captureCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerCaptureResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      remember(captureCache, req.idempotencyKey, result, maxCached);
      return result;
    },

    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      const cached = refundCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerRefundResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      remember(refundCache, req.idempotencyKey, result, maxCached);
      return result;
    },
  };
}
