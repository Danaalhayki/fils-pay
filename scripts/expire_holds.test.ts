import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRE_HOLDS_SQL, expireHolds } from "./expire_holds.js";
import { buildDelete } from "./lib/sqlFilter.js";

test("expiry is a single status flip on active, past-expiry holds — never a DELETE", async () => {
  const seen: string[] = [];
  const fake = { query: async (text: string) => (seen.push(text), { rowCount: 3 }) } as never;
  assert.equal(await expireHolds(fake), 3);
  assert.deepEqual(seen, [EXPIRE_HOLDS_SQL]);
  assert.match(EXPIRE_HOLDS_SQL, /^UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now\(\)$/);
});

test("the delete is scoped to exactly the ids it was handed", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  const { text, values } = buildDelete("holds", { id: ids });
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.deepEqual(values, [ids]);
});

test("an empty id list matches nothing instead of dropping the filter", () => {
  const { text, values } = buildDelete("holds", { id: [] });
  assert.equal(text, "DELETE FROM holds WHERE false");
  assert.deepEqual(values, []);
});
