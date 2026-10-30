import assert from "node:assert/strict";
import { test } from "node:test";
import { computeResidueFils, monthBounds, residueEntryGroupId } from "./reconcile_march.js";

test("computeResidueFils returns the amount lost to 2dp quantization", () => {
  assert.equal(computeResidueFils(4750), 0);
  assert.equal(computeResidueFils(4759), 9);
  assert.equal(computeResidueFils(10), 0);
  assert.equal(computeResidueFils(1), 1);
  assert.equal(computeResidueFils(0), 0);
});

test("monthBounds for March 2026 spans 31 days of the Asia/Bahrain calendar", () => {
  const { start, end } = monthBounds(2026, 3);
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  assert.equal(days, 31);
  assert.equal(start.toISOString(), "2026-02-28T21:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-31T21:00:00.000Z");
});

test("residue posting id is deterministic per period and merchant", () => {
  const m = "11111111-1111-1111-1111-111111111111";
  assert.equal(residueEntryGroupId("2026-03", m), residueEntryGroupId("2026-03", m));
  assert.notEqual(residueEntryGroupId("2026-03", m), residueEntryGroupId("2026-04", m));
  assert.match(residueEntryGroupId("2026-03", m), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});
