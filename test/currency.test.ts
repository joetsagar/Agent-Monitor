import test from "node:test";
import assert from "node:assert/strict";
import { formatUsdInGbp, setExchangeRate } from "../web/src/currency.ts";

test("monetary display converts USD to GBP and never relabels unconverted dollars", () => {
  assert.equal(formatUsdInGbp(null), "Unknown");
  assert.equal(formatUsdInGbp(10), "GBP unavailable");
  setExchangeRate({ usdToGbp: 0.8, asOf: "2026-10-30" });
  assert.equal(formatUsdInGbp(10), "£8.00");
  assert.equal(formatUsdInGbp(.01), "£0.0080");
  setExchangeRate({ usdToGbp: -1, asOf: "2026-10-30" });
  assert.equal(formatUsdInGbp(10), "£8.00");
});
