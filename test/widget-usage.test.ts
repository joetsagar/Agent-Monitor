import test from "node:test";
import assert from "node:assert/strict";
import { WidgetUsageService } from "../server/widget-usage.ts";

const result = (status = "ok") => ({ providers: [
  { id: "claude", status, rows: [{ label: "Session (5 hours)", percent: 25, resetsAt: "2026-11-01T01:00:00+00:00", windowSeconds: 18000, secret: "do not copy" }] },
  { id: "codex", status, rows: [{ label: "Weekly (7 days)", percent: 70, resetsAt: null, windowSeconds: 604800 }] },
  { id: "kilo", status, rows: [{ label: "anything", percent: 80, tokens: 123456, resetsAt: null, windowSeconds: 604800 }], cost: 999, chatTitles: ["do not copy"] },
] });

test("usage service projects public fields and preserves Kilo tokens-only decision", async () => {
  const service = new WidgetUsageService({ runner: async () => result(), now: () => 100 });
  assert.equal(service.getSnapshot().providers[0].status, "loading");
  const state = await service.refresh();
  assert.equal(state.updatedAt, 100);
  assert.equal(state.providers[0].rows[0].percent, 25);
  assert.equal(state.providers[0].rows[0].resetsAt, "2026-11-01T01:00:00.000Z");
  assert.equal(state.providers[2].rows[0].tokens, 123456);
  assert.equal(state.providers[2].rows[0].percent, null);
  assert.equal(state.providers[2].rows[0].label, "Tokens (7 days)");
  assert.ok(!JSON.stringify(state).includes("do not copy"));
  state.providers[0].rows[0].percent = 99;
  assert.equal(service.getSnapshot().providers[0].rows[0].percent, 25);
});

test("usage refresh shares an in-flight request instead of overlapping", async () => {
  let calls = 0;
  let complete!: (value: unknown) => void;
  const service = new WidgetUsageService({ runner: () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  const a = service.refresh(); const b = service.refresh();
  assert.equal(a, b); assert.equal(calls, 1); assert.equal(service.getSnapshot().refreshing, true);
  complete(result()); await a;
  assert.equal(service.getSnapshot().refreshing, false);
});

test("provider failure retains last-good rows and exposes only approved friendly errors", async () => {
  let next = result();
  const service = new WidgetUsageService({ runner: async () => next });
  await service.refresh();
  next = { providers: [{ id: "claude", status: "error", error: "exception includes SECRET auth token", rows: [] } as any] };
  const state = await service.refresh();
  assert.equal(state.providers[0].status, "error"); assert.equal(state.providers[0].stale, true);
  assert.equal(state.providers[0].rows[0].percent, 25);
  assert.ok(!JSON.stringify(state).includes("SECRET"));
  assert.equal(state.providers[1].rows[0].percent, 70);
});

test("bridge crashes and malformed numeric payloads cannot erase good data or leak stderr", async () => {
  let fail = false;
  const service = new WidgetUsageService({ runner: async () => { if (fail) throw new Error("Bearer SECRET"); return result(); } });
  await service.refresh(); fail = true;
  const state = await service.refresh();
  assert.ok(state.providers.every((p) => p.stale));
  assert.ok(!JSON.stringify(state).includes("SECRET"));
  const malformed = new WidgetUsageService({ runner: async () => ({ providers: [{ id: "claude", status: "ok", rows: [{ label: "Session (5 hours)", percent: Infinity, resetsAt: "not a date", tokens: 123 }] }] }) });
  const clean = await malformed.refresh();
  assert.equal(clean.providers[0].rows[0].percent, null);
  assert.equal(clean.providers[0].rows[0].resetsAt, null);
  assert.equal(clean.providers[0].rows[0].tokens, null);
});

test("Claude weekly GBP credit balance is projected, zero is valid and last-good credit survives partial failure", async () => {
  let payload: any = { exchangeRate: { usdToGbp: 0.75, asOf: "2026-10-30", secret: "omit" }, providers: [
    { id: "claude", status: "ok", rows: [
      { label: "Session (5 hours)", credits: 99 }, { label: "Weekly (7 days)", credits: 12.34, secret: "omit" },
    ] },
    { id: "kilo", status: "ok", rows: [{ label: "anything", tokens: 5, credits: 999 }] },
  ] };
  const service = new WidgetUsageService({ runner: async () => payload });
  let state = await service.refresh();
  assert.equal(state.providers[0].rows[0].credits, null);
  assert.equal(state.providers[0].rows[1].credits, 12.34);
  assert.equal(state.providers[2].rows[0].credits, null);
  assert.deepEqual(state.exchangeRate, { usdToGbp: 0.75, asOf: "2026-10-30" });
  assert.ok(!JSON.stringify(state).includes("omit"));
  payload.providers[0].rows[1].credits = null;
  payload.exchangeRate = { usdToGbp: -1, asOf: "bad" };
  state = await service.refresh();
  assert.equal(state.providers[0].rows[1].credits, 12.34);
  assert.equal(state.providers[0].rows[1].creditsStale, true);
  assert.equal(state.exchangeRate?.usdToGbp, 0.75);
  payload.providers[0].rows[1].credits = 0;
  state = await service.refresh();
  assert.equal(state.providers[0].rows[1].credits, 0);
  assert.ok(!state.providers[0].rows[1].creditsStale);
});
