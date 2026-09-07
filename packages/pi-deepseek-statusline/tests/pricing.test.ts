// tests/pricing.test.ts — pricing engine: parser against the SAVED live-page
// fixtures (en USD + zh-cn CNY, fetched 2026-09-06) and the fetch-once /
// force-refresh cache policy with an injected fetch counter.
//
// Cache tests use os.tmpdir() directories — never the real ~/.omp.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Schedule } from "../lib/window";
import {
  PRICE_URLS,
  ensurePricing,
  fetchPricing,
  forceRefreshPricing,
  loadPricingCache,
  parsePricingHtml,
  pricingCachePath,
  savePricingCache,
  type PricingCache,
  type PricingData,
} from "../lib/pricing";

// ─── fixtures ───────────────────────────────────────────────────────────────

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

const BASE_IDS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];

/** Canonical UTC schedule both locale pages must normalize to (Mon–Fri). */
const CANONICAL_SCHEDULE: Schedule = {
  spans: [
    { weekdays: [1, 2, 3, 4, 5], startMin: 60, endMin: 240 }, // 01:00–04:00
    { weekdays: [1, 2, 3, 4, 5], startMin: 360, endMin: 600 }, // 06:00–10:00
  ],
};

// ─── parser ─────────────────────────────────────────────────────────────────

describe("parsePricingHtml", () => {
  it("parses the en (USD) fixture: currency tag, base ids, real table values", () => {
    expect(en.currency).toBe("USD");
    expect(Object.keys(en.models)).toEqual(BASE_IDS);
    // Fixture values (per 1M tokens, USD) — asserted against the saved page.
    expect(en.models["deepseek-v4-flash"]!.peak).toEqual({ inHit: 0.014, inMiss: 0.44, out: 1.32 });
    expect(en.models["deepseek-v4-flash"]!.offPeak).toEqual({ inHit: 0.007, inMiss: 0.22, out: 0.66 });
    expect(en.models["deepseek-v4-pro"]!.peak.inMiss).toBe(1.32);
    expect(en.models["deepseek-v4-flash-vision-exp"]!.peak.inHit).toBe(0.014);
  });

  it("parses the zh (CNY) fixture: currency tag, same base ids, yuan values untouched", () => {
    expect(zh.currency).toBe("CNY");
    expect(Object.keys(zh.models)).toEqual(BASE_IDS);
    expect(zh.models["deepseek-v4-flash"]!.peak).toEqual({ inHit: 0.1, inMiss: 3.0, out: 9.0 });
    expect(zh.models["deepseek-v4-flash"]!.offPeak).toEqual({ inHit: 0.05, inMiss: 1.5, out: 4.5 });
    // No cross-currency conversion: the CNY table keeps its own numbers.
    expect(zh.models["deepseek-v4-pro"]!.peak.inMiss).toBe(9.0);
  });

  it("yields ≥1 model from both fixtures", () => {
    expect(Object.keys(en.models).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(zh.models).length).toBeGreaterThanOrEqual(1);
  });

  it("off-peak is exactly half of peak for every model × price component (both fixtures)", () => {
    for (const data of [en, zh]) {
      for (const key of Object.keys(data.models)) {
        const { peak, offPeak } = data.models[key]!;
        expect(offPeak.inHit * 2).toBeCloseTo(peak.inHit, 9);
        expect(offPeak.inMiss * 2).toBeCloseTo(peak.inMiss, 9);
        expect(offPeak.out * 2).toBeCloseTo(peak.out, 9);
      }
    }
  });

  it("produces the SAME canonical UTC schedule from both fixtures (zh ≡ en)", () => {
    // zh-cn states 北京时间 9:00–12:00 / 14:00–18:00 → −8 h must equal the en
    // page's UTC 01:00–04:00 / 06:00–10:00, Mon–Fri, byte for byte.
    expect(zh.schedule).toEqual(en.schedule);
    expect(en.schedule).toEqual(CANONICAL_SCHEDULE);
  });

  it("drops non-pricing rows (base url, context length, concurrency limits, …)", () => {
    // Concurrency-limit row carries 2500/500/2500 in the model columns; it must
    // never leak into prices — the exact key set proves it was dropped.
    expect(Object.keys(en.models)).toHaveLength(3);
    expect(Object.keys(zh.models)).toHaveLength(3);
  });
});

// ─── mocked fetch plumbing ──────────────────────────────────────────────────

function htmlFor(url: string): string {
  if (url === PRICE_URLS.CNY) return ZH_HTML;
  if (url === PRICE_URLS.USD) return EN_HTML;
  throw new Error(`unexpected fetch url: ${url}`);
}

interface FetchMock {
  calls: string[];
  impl: ReturnType<typeof vi.fn>;
}

/** Injectable fetchImpl that counts calls and returns fixture HTML per PRICE_URLS. */
function fetchMock(opts: { fail?: boolean; httpError?: boolean } = {}): FetchMock {
  const calls: string[] = [];
  const impl = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    if (opts.fail) throw new TypeError("simulated network failure");
    if (opts.httpError) return { ok: false, status: 503, text: async () => "service unavailable" };
    return { ok: true, status: 200, text: async () => htmlFor(String(url)) };
  });
  return { calls, impl };
}

// ─── tmp-dir cache harness ──────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pricing-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const cacheFile = (): string => join(dir, "pricing-cache.json");

function seedCache(entries: Record<string, { fetchedAt: string; data: PricingData }>): string {
  const cache: PricingCache = { entries: entries as PricingCache["entries"] };
  const body = JSON.stringify(cache, null, 2);
  writeFileSync(cacheFile(), body);
  return body;
}

// ─── fetchPricing ───────────────────────────────────────────────────────────

describe("fetchPricing", () => {
  it("fetches the currency's own locale page and parses it", async () => {
    const { calls, impl } = fetchMock();
    const res = await fetchPricing("USD", { fetchImpl: impl });
    expect(calls).toEqual([PRICE_URLS.USD]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.currency).toBe("USD");
      expect(res.data.models["deepseek-v4-flash"]).toBeDefined();
    }
  });

  it("returns ok:false with the HTTP status on a non-200 response", async () => {
    const { impl } = fetchMock({ httpError: true });
    const res = await fetchPricing("CNY", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("503");
  });

  it("returns ok:false with the cause on a network failure", async () => {
    const { impl } = fetchMock({ fail: true });
    const res = await fetchPricing("USD", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("simulated network failure");
  });
});

// ─── ensurePricing: fetch-once-keep-forever per currency ────────────────────

describe("ensurePricing", () => {
  it("serves a cached entry at ANY age with zero fetches", async () => {
    seedCache({ USD: { fetchedAt: "2000-01-01T00:00:00.000Z", data: en } });
    const { calls, impl } = fetchMock();
    const res = await ensurePricing("USD", cacheFile(), { fetchImpl: impl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fetched).toBe(false);
      expect(res.data).toEqual(en);
    }
    expect(calls).toHaveLength(0);
  });

  it("no entry + failing fetch → ok:false and nothing persisted", async () => {
    const { impl } = fetchMock({ fail: true });
    const res = await ensurePricing("USD", cacheFile(), { fetchImpl: impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("simulated network failure");
    expect(existsSync(cacheFile())).toBe(false);
  });

  it("no entry + success → fetched and persisted once; later calls serve the cache", async () => {
    const { calls, impl } = fetchMock();
    const first = await ensurePricing("USD", cacheFile(), { fetchImpl: impl });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.fetched).toBe(true);
      expect(first.data.currency).toBe("USD");
    }
    expect(calls).toHaveLength(1);
    expect(calls).toEqual([PRICE_URLS.USD]);

    const onDisk = JSON.parse(readFileSync(cacheFile(), "utf8")) as PricingCache;
    expect(Object.keys(onDisk.entries)).toEqual(["USD"]);
    expect(typeof onDisk.entries.USD?.fetchedAt).toBe("string");
    expect(onDisk.entries.USD?.data).toEqual(first.ok ? first.data : undefined);

    const second = await ensurePricing("USD", cacheFile(), { fetchImpl: impl });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fetched).toBe(false);
    expect(calls).toHaveLength(1); // still exactly one fetch, ever
  });
});

// ─── forceRefreshPricing ────────────────────────────────────────────────────

describe("forceRefreshPricing", () => {
  it("re-fetches every cached currency exactly once and atomically overwrites", async () => {
    const before = seedCache({
      USD: { fetchedAt: "2020-01-01T00:00:00.000Z", data: en },
      CNY: { fetchedAt: "2020-01-02T00:00:00.000Z", data: zh },
    });
    const { calls, impl } = fetchMock();
    const res = await forceRefreshPricing(cacheFile(), { fetchImpl: impl });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect([...calls].sort()).toEqual([PRICE_URLS.USD, PRICE_URLS.CNY].sort());
    if (!res.ok) return;

    expect(res.cache.entries.USD?.fetchedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(res.cache.entries.CNY?.fetchedAt).not.toBe("2020-01-02T00:00:00.000Z");
    expect(res.cache.entries.USD?.data.currency).toBe("USD");
    expect(res.cache.entries.CNY?.data.currency).toBe("CNY");

    const after = readFileSync(cacheFile(), "utf8");
    expect(after).not.toBe(before); // atomically overwritten
    const onDisk = JSON.parse(after) as PricingCache;
    expect(Object.keys(onDisk.entries).sort()).toEqual(["CNY", "USD"]);
    // No temp litter from the atomic write.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("failing fetch → ok:false and the old cache file stays byte-identical", async () => {
    const before = seedCache({
      USD: { fetchedAt: "2020-01-01T00:00:00.000Z", data: en },
      CNY: { fetchedAt: "2020-01-02T00:00:00.000Z", data: zh },
    });
    const { calls, impl } = fetchMock({ fail: true });
    const res = await forceRefreshPricing(cacheFile(), { fetchImpl: impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("simulated network failure");
    expect(calls).toHaveLength(2); // every cached currency was attempted
    expect(readFileSync(cacheFile(), "utf8")).toBe(before); // old cache untouched
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("no cache entries → ok:true with zero fetches and no file created", async () => {
    const { calls, impl } = fetchMock();
    const res = await forceRefreshPricing(cacheFile(), { fetchImpl: impl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cache.entries).toEqual({});
    expect(calls).toHaveLength(0);
    expect(existsSync(cacheFile())).toBe(false);
  });
});

// ─── cache file io ──────────────────────────────────────────────────────────

describe("pricing cache file", () => {
  it("pricingCachePath nests under agentDir/extensions/deepseek-statusline", () => {
    expect(pricingCachePath("/home/u/.omp/agent")).toBe(
      join("/home/u/.omp/agent", "extensions", "deepseek-statusline", "pricing-cache.json"),
    );
  });

  it("loadPricingCache: missing file → empty cache, no throw", async () => {
    await expect(loadPricingCache(cacheFile())).resolves.toEqual({ entries: {} });
  });

  it("loadPricingCache: corrupt or mis-shaped file → empty cache, no throw", async () => {
    writeFileSync(cacheFile(), "{ definitely not json");
    await expect(loadPricingCache(cacheFile())).resolves.toEqual({ entries: {} });

    writeFileSync(cacheFile(), JSON.stringify({ entries: { EUR: { fetchedAt: "x", data: { currency: "USD" } } } }));
    await expect(loadPricingCache(cacheFile())).resolves.toEqual({ entries: {} });

    writeFileSync(cacheFile(), JSON.stringify({ entries: { USD: "not an entry" } }));
    await expect(loadPricingCache(cacheFile())).resolves.toEqual({ entries: {} });
  });

  it("savePricingCache writes atomically (no temp litter) and round-trips", async () => {
    const target = join(dir, "nested", "extensions", "deepseek-statusline", "pricing-cache.json");
    const cache: PricingCache = { entries: { USD: { fetchedAt: "2026-09-06T00:00:00.000Z", data: en } } };
    await savePricingCache(target, cache);
    expect(existsSync(target)).toBe(true); // parent dirs created
    await expect(loadPricingCache(target)).resolves.toEqual(cache);
    expect(readdirSync(join(dir, "nested", "extensions", "deepseek-statusline")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("savePricingCache: failure leaves no partial file and throws", async () => {
    // A regular file blocking the target's parent dir makes mkdir/write fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "occupied");
    const target = join(dir, "blocker", "pricing-cache.json");
    const cache: PricingCache = { entries: { CNY: { fetchedAt: "2026-09-06T00:00:00.000Z", data: zh } } };
    await expect(savePricingCache(target, cache)).rejects.toThrow();
    expect(readFileSync(blocker, "utf8")).toBe("occupied"); // existing state untouched
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
