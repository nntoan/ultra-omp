// lib/cost.ts — session cost estimate: prices a usage ledger's model × phase
// buckets against ONE parsed pricing table (see ./pricing).
//
// Each ledger bucket already carries its schedule phase (`peak` | `offPeak`,
// assigned by ./usage at aggregation time; no schedule available yet ⇒ `peak`
// = full rate). This module only maps a bucket to the matching pricing row —
// it never computes phase/schedule math (buckets carry phase) and never
// converts currency: the passed PricingData's own currency tags every number
// returned.
//
// Formula per priced bucket, using the row whose base key is matched by
// `modelId.startsWith(key)` (longest key wins) and the bucket's own phase
// rows (peak bucket → peak row, offPeak bucket → offPeak row):
//   (cacheHit*inHit + cacheMiss*inMiss + output*out) / 1e6
// Prices are per 1M tokens; token counts are exact integers. A bucket whose
// model matches NO pricing key is unpriced: cost 0 and every token reported
// as unpricedTokens — never guessed.

import type { BucketPhase, SessionLedger } from "./usage";
import type { PricingData } from "./pricing";

/** Cost of a single ledger bucket, denominated in `pricing.currency`. */
export interface BucketCost {
  /** Model id carried by the ledger bucket. */
  modelId: string;
  /** Schedule phase carried by the ledger bucket (peak = full rate). */
  phase: BucketPhase;
  /** Pricing base key matched via `modelId.startsWith(key)`; null when the model is unpriced. */
  key: string | null;
  /** Cost in `pricing.currency` units ((tokens × price)/1e6); 0 when unpriced. */
  cost: number;
  /** Tokens that could not be priced (whole bucket when `key` is null, else 0). */
  unpricedTokens: number;
}

/** Whole-ledger cost estimate, denominated in `pricing.currency`. */
export interface SessionCost {
  /** Sum of priced bucket costs (ignores unpriced buckets). */
  total: number;
  /** Sum of unpriced tokens across all buckets. */
  unpricedTokens: number;
}

/**
 * Longest pricing base key that is a prefix of `modelId`, in table order
 * (ties cannot occur: two equal-length matching keys would be identical).
 * Returns null when no row matches — the model is unpriced.
 */
export function findPricingKey(modelId: string, pricing: PricingData): string | null {
  let best: string | null = null;
  for (const key of Object.keys(pricing.models)) {
    if (modelId.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}

/**
 * Price one ledger bucket against `pricing`. The bucket's phase selects the
 * row set (peak rows for a peak bucket, offPeak rows for an offPeak bucket);
 * an unknown model yields cost 0 with its tokens reported unpriced.
 */
export function costPerBucket(
  bucket: SessionLedger["buckets"][number],
  pricing: PricingData,
): BucketCost {
  const key = findPricingKey(bucket.modelId, pricing);
  if (key === null) {
    return {
      modelId: bucket.modelId,
      phase: bucket.phase,
      key: null,
      cost: 0,
      unpricedTokens: bucket.cacheHit + bucket.cacheMiss + bucket.output,
    };
  }
  const entry = pricing.models[key];
  const set = bucket.phase === "peak" ? entry.peak : entry.offPeak;
  return {
    modelId: bucket.modelId,
    phase: bucket.phase,
    key,
    cost: (bucket.cacheHit * set.inHit + bucket.cacheMiss * set.inMiss + bucket.output * set.out) / 1e6,
    unpricedTokens: 0,
  };
}

/**
 * Price every bucket of a ledger in ledger order and aggregate: `total`
 * ignores unpriced buckets, `unpricedTokens` sums the tokens they carry.
 */
export function estimateSessionCost(ledger: SessionLedger, pricing: PricingData): SessionCost {
  let total = 0;
  let unpricedTokens = 0;
  for (const bucket of ledger.buckets) {
    const entry = costPerBucket(bucket, pricing);
    total += entry.cost;
    unpricedTokens += entry.unpricedTokens;
  }
  return { total, unpricedTokens };
}
