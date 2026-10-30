const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD. `Date.parse` alone accepts 2026-02-30 (rolls to March 2) and Postgres then rejects it. */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Asia/Bahrain local midnight on `dateStr` as a UTC instant (fixed UTC+3, no DST). */
export function bahrainMidnightUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+03:00`);
}

/** Today's calendar date in Asia/Bahrain (UTC+3), YYYY-MM-DD. */
export function bahrainToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A `from`/`to` bound: YYYY-MM-DD means Bahrain midnight (ADR-0003);
 * otherwise an ISO-8601 instant with an explicit offset. Anything else
 * (including impossible dates) is undefined.
 */
export function parseBoundParam(value: string): Date | undefined {
  const datePart = value.slice(0, 10);
  if (datePart === value && isValidDateString(value)) return bahrainMidnightUtc(datePart);
  if (!INSTANT_RE.test(value) || !isValidDateString(datePart)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
