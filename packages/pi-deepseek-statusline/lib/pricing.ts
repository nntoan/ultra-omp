// lib/pricing.ts — official DeepSeek pricing-page fetch + parser per currency,
// with a fetch-once-keep-forever JSON cache.
//
// Source of truth: the two official locale pages (en = USD, zh-cn = CNY), both
// fetched WITH the trailing slash (the no-slash URL serves stale content):
//   https://api-docs.deepseek.com/quick_start/pricing/
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//
// The parser reads the REAL <table> markup of those pages and the schedule
// sentence. Every number comes from the DOM — nothing is hard-coded, and the
// parser never assumes USD. Numbers are per 1M tokens, currency-tagged by the
// locale page (en = USD, zh-cn = CNY 元); they are never converted.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scheduleFromSpans, type Schedule } from "./window";

export type Currency = "USD" | "CNY";

/** Official locale pages. The trailing slash is REQUIRED (bare paths serve stale content). */
export const PRICE_URLS: Record<Currency, string> = {
  USD: "https://api-docs.deepseek.com/quick_start/pricing/",
  CNY: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
};

export interface PriceSet {
  /** input, cache hit — per 1M tokens */
  inHit: number;
  /** input, cache miss — per 1M tokens */
  inMiss: number;
  /** output — per 1M tokens */
  out: number;
}

export interface PricingData {
  currency: Currency;
  /** keyed by base model id, in table order */
  models: Record<string, { peak: PriceSet; offPeak: PriceSet }>;
  /** canonical UTC schedule (weekdays ISO 1=Mon..7=Sun), same shape for both locales */
  schedule: Schedule;
}

export interface CacheEntry {
  fetchedAt: string;
  data: PricingData;
}

export interface PricingCache {
  entries: Partial<Record<Currency, CacheEntry>>;
}

// ─── tiny HTML helpers ──────────────────────────────────────────────────────

function stripTags(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── table parsing (real markup) ────────────────────────────────────────────
//
// Actual live markup (both locales, verified 2026-09-06): one <table> whose
// first row is the model header — a colspan-3 label cell followed by one cell
// per model holding the base id (deepseek-v4-flash / deepseek-v4-pro /
// deepseek-v4-flash-vision-exp). Below it a "PRICING" section (label
// rowspan=6) where each metric (cache-hit input / cache-miss input / output,
// label rowspan=2) occupies TWO physical rows: an off-peak row ("OFF-PEAK" /
// "空闲时段") then a peak row ("PEAK" / "高峰时段"), each carrying the three
// per-model prices. Non-pricing rows (base url, context length, concurrency
// limit, …) carry no phase label and are ignored.

interface RawCell {
  text: string;
  colspan: number;
  rowspan: number;
}

interface PlacedCell {
  col: number;
  colspan: number;
  text: string;
}

interface ExpandedTable {
  /** grid[row][col] — rowspan cells repeat their text into later rows */
  grid: string[][];
  /** per-row physical cell placements with their starting column */
  placements: PlacedCell[][];
}

function extractFirstTable(html: string): string {
  const m = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!m) throw new Error("pricing page: no <table> element found");
  return m[1];
}

function tokenizeRows(tableBody: string): RawCell[][] {
  const rows: RawCell[][] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tableBody)) !== null) {
    const cells: RawCell[] = [];
    const tdRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(tr[1])) !== null) {
      const attrs = td[1] ?? "";
      const span = (name: "colspan" | "rowspan"): number => {
        const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attrs);
        return m ? Math.max(1, parseInt(m[1], 10)) : 1;
      };
      cells.push({ text: stripTags(td[2]), colspan: span("colspan"), rowspan: span("rowspan") });
    }
    rows.push(cells);
  }
  return rows;
}

function expandTable(tableBody: string): ExpandedTable {
  const rows = tokenizeRows(tableBody);
  const grid: string[][] = [];
  const placements: PlacedCell[][] = [];
  // col -> rowspan text still owed to later rows
  let pending = new Map<number, { left: number; text: string }>();

  for (const row of rows) {
    const out: string[] = [];
    const placed: PlacedCell[] = [];
    const next = new Map<number, { left: number; text: string }>();
    let c = 0;
    for (const cell of row) {
      while (pending.has(c)) {
        const p = pending.get(c)!;
        out[c] = p.text;
        if (p.left > 1) next.set(c, { left: p.left - 1, text: p.text });
        pending.delete(c);
        c++;
      }
      placed.push({ col: c, colspan: cell.colspan, text: cell.text });
      for (let i = 0; i < cell.colspan; i++) {
        if (i === 0) {
          out[c + i] = cell.text;
          if (cell.rowspan > 1) next.set(c + i, { left: cell.rowspan - 1, text: cell.text });
        }
      }
      c += cell.colspan;
    }
    for (const [col, p] of pending) {
      out[col] = p.text;
      if (p.left > 1) next.set(col, { left: p.left - 1, text: p.text });
    }
    grid.push(out);
    placements.push(placed);
    pending = next;
  }
  return { grid, placements };
}

// ─── model / metric / phase classification ──────────────────────────────────

const BASE_MODEL_IDS = [
  "deepseek-v4-flash-vision-exp", // longest first so startsWith never shadows it
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

/**
 * Normalize a model column header to a known base id. Version-suffixed and
 * case/spacing variants of the known ids are recognized; anything else
 * (unknown future models, non-model cells) yields undefined and is dropped.
 */
function normalizeModelKey(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "") return undefined;
  for (const base of BASE_MODEL_IDS) {
    if (t === base || t.startsWith(`${base}-`) || t.startsWith(`${base}_`)) return base;
  }
  // "DeepSeek-V4-Flash-0731", "deepseek_v4_flash_0731", "v4-flash-vision-exp"…
  const m = /^(?:deepseek[-_]?)?v4[-_]?(flash|pro)([-_]vision[-_]exp)?(?:[-_]\d+)?$/.exec(t);
  if (m) return m[2] ? "deepseek-v4-flash-vision-exp" : `deepseek-v4-${m[1]}`;
  return undefined;
}

type Phase = "peak" | "offPeak";

function phaseOf(text: string): Phase | undefined {
  if (/高峰时段|peak/i.test(text) && !/off[- ]?peak|空闲时段/i.test(text)) return "peak";
  if (/off[- ]?peak|空闲时段/i.test(text)) return "offPeak";
  return undefined;
}

type MetricField = keyof PriceSet;

function metricFieldOf(text: string): MetricField | undefined {
  if (/cache\s*hit|缓存命中/i.test(text)) return "inHit";
  if (/cache\s*miss|缓存未命中/i.test(text)) return "inMiss";
  if (/output|输出/i.test(text)) return "out";
  return undefined;
}

/** Pull the numeric literal out of a price cell ("$0.007", "0.05元", "1.5元"). */
function priceOf(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number.parseFloat(m[1]) : undefined;
}

// ─── schedule sentence parsing ──────────────────────────────────────────────

function extractScheduleSentence(html: string): string {
  const text = stripTags(html);
  const marker = text.search(/Peak hours are|高峰时段为/);
  if (marker < 0) throw new Error("pricing page: schedule sentence not found");
  let sentence = text.slice(marker, marker + 400);
  const nextNote = sentence.search(/\(2\)|（2）/);
  if (nextNote >= 0) sentence = sentence.slice(0, nextNote);
  return sentence.trim();
}

const DAYS_EN: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 7,
};
const DAYS_ZH: Record<string, number> = {
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 7, 星期天: 7,
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7, 周天: 7,
};

/** Weekday numbers (ISO 1=Mon..7=Sun) named in the sentence, ascending. */
function parseWeekdays(sentence: string): number[] {
  const hits: Array<{ pos: number; day: number }> = [];
  for (const [name, day] of Object.entries(DAYS_EN)) {
    let pos = sentence.toLowerCase().indexOf(name);
    while (pos !== -1) {
      hits.push({ pos, day });
      pos = sentence.toLowerCase().indexOf(name, pos + 1);
    }
  }
  for (const [name, day] of Object.entries(DAYS_ZH)) {
    let pos = sentence.indexOf(name);
    while (pos !== -1) {
      hits.push({ pos, day });
      pos = sentence.indexOf(name, pos + 1);
    }
  }
  hits.sort((a, b) => a.pos - b.pos);
  const days = [...new Set(hits.map((h) => h.day))].sort((a, b) => a - b);
  if (days.length === 0) throw new Error("pricing page: no weekday names in schedule sentence");
  // A contiguous range ("Monday through Friday", "周一至周五") fills the span;
  // an explicit list of named days stays as-is.
  if (days.length === 2 && /through|through |to |至|[-–—~]/.test(sentence)) {
    const [a, b] = days;
    if (b > a) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return days;
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`pricing page: bad time "${hhmm}" in schedule sentence`);
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

function toHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Parse the schedule sentence into the canonical UTC Schedule. Detects the
 * timezone token (UTC vs 北京时间); for 北京时间 (UTC+8, no DST) it subtracts
 * 8 h so both locale pages yield the SAME canonical schedule.
 */
function parseSchedule(html: string): Schedule {
  const sentence = extractScheduleSentence(html);
  const cny = sentence.includes("北京时间"); // Asia/Shanghai = UTC+8, no DST
  const tzShiftMin = cny ? 8 * 60 : 0;
  const weekdays = parseWeekdays(sentence);
  const timeRe = /(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/g;
  const spans: Array<{ weekdays: number[]; start: string; end: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = timeRe.exec(sentence)) !== null) {
    const start = toMinutes(`${m[1]}:${m[2]}`) - tzShiftMin;
    const end = toMinutes(`${m[3]}:${m[4]}`) - tzShiftMin;
    spans.push({ weekdays, start: toHHMM(start), end: toHHMM(end) });
  }
  if (spans.length === 0) throw new Error("pricing page: no time windows in schedule sentence");
  return scheduleFromSpans(spans);
}

// ─── public parser ──────────────────────────────────────────────────────────

/**
 * Parse an official pricing page (raw HTML) into normalized PricingData.
 * Currency is supplied by the caller (USD = en page, CNY = zh-cn page) and
 * tags the result; numbers are always read from the DOM, never converted.
 */
export function parsePricingHtml(html: string, currency: Currency): PricingData {
  const tableBody = extractFirstTable(html);
  const { grid, placements } = expandTable(tableBody);

  // Model columns come from the first row whose placements carry ≥2 known ids.
  let modelCols: Array<{ col: number; key: string }> | undefined;
  for (const row of placements) {
    const found = row
      .map((p) => ({ col: p.col, key: normalizeModelKey(p.text) }))
      .filter((p): p is { col: number; key: string } => p.key !== undefined);
    if (found.length >= 2) {
      modelCols = found.sort((a, b) => a.col - b.col);
      break;
    }
  }
  if (!modelCols || modelCols.length === 0) {
    throw new Error("pricing page: no known model columns found in table header");
  }
  const labelEnd = modelCols[0].col; // label cells live left of the first model column

  // Accumulate per model: phase -> metric -> price.
  const acc = new Map<string, { peak: Partial<PriceSet>; offPeak: Partial<PriceSet> }>();
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    let phase: Phase | undefined;
    let phaseCol = -1;
    for (let c = 0; c < labelEnd; c++) {
      const p = phaseOf(row[c] ?? "");
      if (p !== undefined) {
        phase = p;
        phaseCol = c;
        break;
      }
    }
    if (phase === undefined) continue; // non-pricing row (features, limits, …)

    let metric: MetricField | undefined;
    for (let c = 0; c < labelEnd; c++) {
      if (c === phaseCol) continue;
      const kind = metricFieldOf(row[c] ?? "");
      if (kind !== undefined) {
        metric = kind;
        break;
      }
    }
    if (metric === undefined) {
      throw new Error(`pricing page: phase row ${r} has no recognizable metric label`);
    }

    const prices = modelCols.map(({ col }) => priceOf(row[col] ?? ""));
    if (prices.some((p) => p === undefined)) {
      throw new Error(`pricing page: row ${r} (${metric} / ${phase}) has a non-numeric price cell`);
    }
    modelCols.forEach(({ col, key }, i) => {
      let entry = acc.get(key);
      if (!entry) {
        entry = { peak: {}, offPeak: {} };
        acc.set(key, entry);
      }
      entry[phase][metric] = prices[i]!;
    });
  }
  if (acc.size === 0) throw new Error("pricing page: no priced model rows parsed");

  const models: PricingData["models"] = {};
  for (const [key, entry] of acc) {
    const finish = (partial: Partial<PriceSet>, phase: Phase): PriceSet => {
      const { inHit, inMiss, out } = partial;
      if (inHit === undefined || inMiss === undefined || out === undefined) {
        throw new Error(`pricing page: model ${key} is missing ${phase} prices (inHit/inMiss/out)`);
      }
      return { inHit, inMiss, out };
    };
    models[key] = { peak: finish(entry.peak, "peak"), offPeak: finish(entry.offPeak, "offPeak") };
  }

  return { currency, models, schedule: parseSchedule(html) };
}

// ─── fetching ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch + parse the official page for one currency. Never throws. */
export async function fetchPricing(
  currency: Currency,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: true; data: PricingData } | { ok: false; error: string }> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const url = PRICE_URLS[currency];
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return { ok: false, error: `fetch failed for ${url}: ${errorMessage(err)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} fetching ${url}` };
  }
  try {
    const data = parsePricingHtml(await res.text(), currency);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `parse failed for ${url}: ${errorMessage(err)}` };
  }
}

// ─── cache ──────────────────────────────────────────────────────────────────

/** Cache file location under an agent dir: <agentDir>/extensions/deepseek-statusline/pricing-cache.json */
export function pricingCachePath(agentDir: string): string {
  return join(agentDir, "extensions", "deepseek-statusline", "pricing-cache.json");
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("fetchedAt" in value) || typeof value.fetchedAt !== "string") return false;
  if (!("data" in value)) return false;
  const data = value.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  if (!("currency" in data)) return false;
  return data.currency === "USD" || data.currency === "CNY";
}

function isPricingCache(value: unknown): value is PricingCache {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("entries" in value)) return false;
  const entries = value.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return false;
  return Object.entries(entries).every(
    ([key, entry]) => (key === "USD" || key === "CNY") && (entry === undefined || isCacheEntry(entry)),
  );
}

/** Read the cache; a missing or corrupt file yields an empty cache, never a throw. */
export async function loadPricingCache(filePath: string): Promise<PricingCache> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPricingCache(parsed) ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

/**
 * Persist the cache atomically (temp file + rename). On any failure the
 * previous file content is untouched and the temp file is removed.
 */
export async function savePricingCache(filePath: string, cache: PricingCache): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ─── fetch policy: fetch-once-keep-forever, per currency ────────────────────

/**
 * Return the cached parse for a currency when one exists (ANY age — no TTL),
 * otherwise fetch once, persist it, and report `fetched: true`.
 */
export async function ensurePricing(
  currency: Currency,
  filePath: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<
  | { ok: true; data: PricingData; fetched: boolean }
  | { ok: false; error: string }
> {
  const cache = await loadPricingCache(filePath);
  const existing = cache.entries[currency];
  if (existing) return { ok: true, data: existing.data, fetched: false };
  const fetched = await fetchPricing(currency, opts);
  if (!fetched.ok) return fetched;
  const next: PricingCache = {
    entries: { ...cache.entries, [currency]: { fetchedAt: new Date().toISOString(), data: fetched.data } },
  };
  try {
    await savePricingCache(filePath, next);
  } catch (err) {
    return { ok: false, error: `failed to persist pricing cache: ${errorMessage(err)}` };
  }
  return { ok: true, data: fetched.data, fetched: true };
}

/**
 * User-initiated refresh: re-fetch EVERY currency that has a cache entry
 * (exactly one fetch per currency) and atomically overwrite the cache — but
 * only when every fetch succeeds. On any failure the old cache is untouched.
 */
export async function forceRefreshPricing(
  filePath: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: true; cache: PricingCache } | { ok: false; error: string }> {
  const cache = await loadPricingCache(filePath);
  const currencies = Object.keys(cache.entries) as Currency[];
  if (currencies.length === 0) return { ok: true, cache };

  const results = await Promise.all(
    currencies.map(async (currency) => ({ currency, result: await fetchPricing(currency, opts) })),
  );
  const failed = results.filter((r): r is { currency: Currency; result: { ok: false; error: string } } => !r.result.ok);
  if (failed.length > 0) {
    return { ok: false, error: failed.map((f) => `${f.currency}: ${f.result.error}`).join("; ") };
  }

  const fetchedAt = new Date().toISOString();
  const entries: PricingCache["entries"] = {};
  for (const { currency, result } of results) {
    if (result.ok) entries[currency] = { fetchedAt, data: result.data };
  }
  const next: PricingCache = { entries };
  try {
    await savePricingCache(filePath, next);
  } catch (err) {
    return { ok: false, error: `failed to persist refreshed pricing cache: ${errorMessage(err)}` };
  }
  return { ok: true, cache: next };
}
