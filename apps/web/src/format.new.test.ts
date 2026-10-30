import assert from "node:assert/strict";
import { test } from "node:test";
import { bhd } from "./format.js";

test("bhd renders negative amounts (reconciliation gaps) instead of throwing", () => {
  assert.equal(bhd(-4750), "-4.750 BHD");
  assert.equal(bhd(-1), "-0.001 BHD");
});
