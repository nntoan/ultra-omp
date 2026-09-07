// tests/cost.test.ts — cost engine: ledger model × phase buckets priced
// against the SAVED live-page fixtures (en USD + zh-cn CNY, fetched
// 2026-09-06).
//
// Every expected value is derived from the parsed fixture PricingData by the
// local helpers at the bottom (never hard-coded); float assertions use
// toBeCloseTo(…, 9), token sums are exact integers.
//
// Buckets carry their phase already (peak = full rate; usage.ts falls back to
// "peak" before any schedule exists), so the engine never sees the schedule.

import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BucketPhase, SessionLedger } from "../lib/usage";
import { parsePricingHtml, type PricingData } from "../lib/pricing";
import {
  costPerBucket,
  estimateSessionCost,
  findPricingKey,
  type BucketCost,
  type SessionCost,
} from "../lib/cost";

// ─── fixtures (locator mirrors tests/pricing.test.ts) ───────────────────────

function fixturePath(locale: "en" | "zh"): string {
  const dir = fileURLToPath(new URL("./fixtures", import.meta.url));
  const matches = readdirSync(dir)
    .filter((f) => new RegExp(`^pricing-${locale}-\\d{8}\\.html$`).test(f))
    .sort();
  if (matches.length === 0) throw new Error(`missing pricing-${locale}-*.html fixture in ${dir}`);
  return join(dir, matches[matches.length - 1]);
}

const EN_HTML = readFileSync(fixturePath("en"), "utf8");
const ZH_HTML = readFileSync(fixturePath("zh"), "utf8");

let en: PricingData;
let zh: PricingData;

beforeAll(() => {
  en = parsePricingHtml(EN_HTML, "USD");
  zh = parsePricingHtml(ZH_HTML, "CNY");
});

// ─── local fixtures / expectation helpers (fixture-derived, never hard-coded)

interface TestBucket {
  modelId: string;
  phase: BucketPhase;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/** Build a typed SessionLedger literal around buckets in ledger order. */
function makeLedger(buckets: TestBucket[]): SessionLedger {
  return {
    sessionId: "cost-test-session",
    cwd: "/workspace/deepseek",
    startTs: 1_750_000_000_000,
    lastTs: 1_750_000_060_000,
    buckets,
  };
}

/** Row set a bucket of `phase` is priced against, looked up by exact model id. */
function rowsOf(modelId: string, phase: BucketPhase, pricing: PricingData) {
  const entry = pricing.models[modelId];
  if (!entry) throw new Error(`fixture has no model row for ${modelId}`);
  return phase === "peak" ? entry.peak : entry.offPeak;
}

/** Fixture-derived expectation: (cacheHit*hit + cacheMiss*miss + output*out)/1e6. */
function expectedBucketCost(bucket: TestBucket, pricing: PricingData): number {
  const set = rowsOf(bucket.modelId, bucket.phase, pricing);
  return (bucket.cacheHit * set.inHit + bucket.cacheMiss * set.inMiss + bucket.output * set.out) / 1e6;
}

/** Fixture-derived expectation for a whole ledger, summed in ledger order. */
function expectedTotal(ledger: SessionLedger, pricing: PricingData): number {
  return ledger.buckets.reduce((sum, bucket) => sum + expectedBucketCost(bucket, pricing), 0);
}

/**
 * A model id guaranteed to match NO fixture key. `deepseek-chat` should be
 * absent from the current v4 tables (guarded); if a future table ever adds
 * it, fall back to a clearly-unknown id.
 */
function unknownModelId(pricing: PricingData): string {
  const candidate = "deepseek-chat";
  const keys = Object.keys(pricing.models);
  if (!keys.includes(candidate) && !keys.some((key) => candidate.startsWith(key))) return candidate;
  return "no-such-model";
}

// ─── findPricingKey ─────────────────────────────────────────────────────────

describe("findPricingKey", () => {
  it("matches base ids via startsWith; the longest matching key wins", () => {
    expect(findPricingKey("deepseek-v4-flash", en)).toBe("deepseek-v4-flash");
    expect(findPricingKey("deepseek-v4-flash-20260906", en)).toBe("deepseek-v4-flash");
    expect(findPricingKey("deepseek-v4-pro", en)).toBe("deepseek-v4-pro");
    expect(findPricingKey("deepseek-v4-flash-vision-exp", en)).toBe("deepseek-v4-flash-vision-exp");
    expect(findPricingKey("", en)).toBeNull();
  });
});

// ─── estimateSessionCost ────────────────────────────────────────────────────

describe("estimateSessionCost", () => {
  it("exact sums against both fixture tables (flash + pro peak buckets)", () => {
    const buckets: TestBucket[] = [
      { modelId: "deepseek-v4-flash", phase: "peak", cacheHit: 1_234_567, cacheMiss: 456_789, output: 123_456 },
      { modelId: "deepseek-v4-pro", phase: "peak", cacheHit: 0, cacheMiss: 2_345_678, output: 654_321 },
    ];
    const ledger = makeLedger(buckets);
    for (const pricing of [en, zh]) {
      const estimate: SessionCost = estimateSessionCost(ledger, pricing);
      expect(estimate.total).toBeCloseTo(expectedTotal(ledger, pricing), 9);
      expect(estimate.unpricedTokens).toBe(0);
    }
  });

  it("offPeak buckets price at off-peak rows: same tokens cost exactly half the peak cost", () => {
    const tokens = { cacheHit: 1_000_000, cacheMiss: 500_000, output: 250_000 };
    const peakBucket: TestBucket = { modelId: "deepseek-v4-flash", phase: "peak", ...tokens };
    const offPeakBucket: TestBucket = { modelId: "deepseek-v4-flash", phase: "offPeak", ...tokens };
    const ledger = makeLedger([peakBucket, offPeakBucket]);
    for (const pricing of [en, zh]) {
      const peak: BucketCost = costPerBucket(ledger.buckets[0], pricing);
      const offPeak: BucketCost = costPerBucket(ledger.buckets[1], pricing);
      expect(peak.cost).toBeCloseTo(expectedBucketCost(peakBucket, pricing), 9);
      expect(offPeak.cost).toBeCloseTo(expectedBucketCost(offPeakBucket, pricing), 9);
      expect(offPeak.cost).toBeCloseTo(peak.cost / 2, 9);
    }
  });

  it("schedule-missing ledger (every bucket phase 'peak') prices at full peak-row rate", () => {
    const buckets: TestBucket[] = [
      { modelId: "deepseek-v4-flash", phase: "peak", cacheHit: 1_000_000, cacheMiss: 100_000, output: 100_000 },
      { modelId: "deepseek-v4-pro", phase: "peak", cacheHit: 100_000, cacheMiss: 100_000, output: 10_000 },
      { modelId: "deepseek-v4-flash-vision-exp", phase: "peak", cacheHit: 50_000, cacheMiss: 50_000, output: 5_000 },
    ];
    const ledger = makeLedger(buckets);
    for (const pricing of [en, zh]) {
      const estimate = estimateSessionCost(ledger, pricing);
      // Helper looks up the PEAK rows of each model — the full, undiscounted rate.
      expect(estimate.total).toBeCloseTo(expectedTotal(ledger, pricing), 9);
      expect(estimate.unpricedTokens).toBe(0);
    }
  });

  it("unknown model: bucket unpriced, ignored by the total, tokens reported", () => {
    for (const pricing of [en, zh]) {
      const unknownId = unknownModelId(pricing);
      // Guard: deepseek-chat must match NO fixture key (absent from the v4 tables).
      const keys = Object.keys(pricing.models);
      expect(keys).not.toContain(unknownId);
      expect(keys.some((key) => unknownId.startsWith(key))).toBe(false);
      expect(findPricingKey(unknownId, pricing)).toBeNull();

      const unknownBucket: TestBucket = { modelId: unknownId, phase: "peak", cacheHit: 999_999, cacheMiss: 1, output: 2 };
      const entry = costPerBucket(unknownBucket, pricing);
      expect(entry.key).toBeNull();
      expect(entry.cost).toBe(0);
      expect(entry.unpricedTokens).toBe(unknownBucket.cacheHit + unknownBucket.cacheMiss + unknownBucket.output);

      const pricedBucket: TestBucket = { modelId: "deepseek-v4-flash", phase: "peak", cacheHit: 500_000, cacheMiss: 500_000, output: 50_000 };
      const estimate = estimateSessionCost(makeLedger([unknownBucket, pricedBucket]), pricing);
      expect(estimate.total).toBeCloseTo(expectedBucketCost(pricedBucket, pricing), 9);
      expect(estimate.unpricedTokens).toBe(unknownBucket.cacheHit + unknownBucket.cacheMiss + unknownBucket.output);
    }
  });

  it("costPerBucket entries sum to the estimate total and mirror ledger order", () => {
    const buckets: TestBucket[] = [
      { modelId: "deepseek-v4-flash", phase: "peak", cacheHit: 1_000_000, cacheMiss: 0, output: 100_000 },
      { modelId: "deepseek-v4-pro", phase: "offPeak", cacheHit: 0, cacheMiss: 600_000, output: 75_000 },
      { modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 300_000, cacheMiss: 300_000, output: 40_000 },
      { modelId: "deepseek-v4-flash-vision-exp", phase: "peak", cacheHit: 5_000, cacheMiss: 5_000, output: 1_000 },
      { modelId: unknownModelId(en), phase: "peak", cacheHit: 1_000, cacheMiss: 2_000, output: 3_000 },
    ];
    const ledger = makeLedger(buckets);
    const entries = ledger.buckets.map((bucket) => costPerBucket(bucket, en));

    // Bucket list order mirrors ledger order.
    expect(entries.map((e) => e.modelId)).toEqual(ledger.buckets.map((b) => b.modelId));
    expect(entries.map((e) => e.phase)).toEqual(ledger.buckets.map((b) => b.phase));

    // Each priced bucket equals its fixture-derived expectation (incl. off-peak rows).
    for (let i = 0; i < buckets.length - 1; i++) {
      expect(entries[i].cost).toBeCloseTo(expectedBucketCost(buckets[i], en), 9);
      expect(entries[i].unpricedTokens).toBe(0);
    }

    // Per-bucket costs sum to the estimate total; unpriced tokens aggregate too.
    const estimate = estimateSessionCost(ledger, en);
    expect(entries.reduce((sum, e) => sum + e.cost, 0)).toBeCloseTo(estimate.total, 9);
    expect(entries.reduce((sum, e) => sum + e.unpricedTokens, 0)).toBe(estimate.unpricedTokens);
    expect(estimate.unpricedTokens).toBe(6_000);
  });

  it("prices only from the passed table: same ledger matches each fixture expectation, ratio preserved", () => {
    const buckets: TestBucket[] = [
      { modelId: "deepseek-v4-flash", phase: "peak", cacheHit: 2_000_000, cacheMiss: 300_000, output: 150_000 },
      { modelId: "deepseek-v4-pro", phase: "peak", cacheHit: 100_000, cacheMiss: 900_000, output: 80_000 },
      { modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 400_000, cacheMiss: 200_000, output: 60_000 },
    ];
    const ledger = makeLedger(buckets);

    const enTotal = estimateSessionCost(ledger, en).total;
    const zhTotal = estimateSessionCost(ledger, zh).total;
    const enExpected = expectedTotal(ledger, en);
    const zhExpected = expectedTotal(ledger, zh);

    expect(en.currency).toBe("USD");
    expect(zh.currency).toBe("CNY");
    expect(enTotal).toBeCloseTo(enExpected, 9);
    expect(zhTotal).toBeCloseTo(zhExpected, 9);
    // Same ledger, two untouched currency tables: the observed ratio between the
    // totals equals the ratio of the two fixture-derived expectations — proving
    // no cross-currency mixing or conversion.
    expect(enTotal / zhTotal).toBeCloseTo(enExpected / zhExpected, 9);
  });
});
