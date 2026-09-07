// tests/statusline.test.ts — Task 9: the pure renderer (lib/render) and the
// status-line controller (lib/statusline).
//
// Renderer tests pin EXACT output strings, including the SPEC Code Style
// example line byte-for-byte. Controller tests drive the controller through a
// fake clock + fake env (mocked ctx.ui.setStatus, fetch/resolve/persistence
// doubles): synchronous setStatus after every usage event (per turn and
// tool-call step), countdown-only 1 s ticks, visibility transitions, balance
// cadence (immediate on visibility gain, balanceRefreshSec cycle, 401 retried
// at balanceRetrySec, network keeps the last rows), pricing first-fetch per
// needed currency only when visible with a 5-minute failure retry ceiling,
// ledger-watch (subagent) recompute with foreign-cwd exclusion, and the
// session lifecycle (shutdown clears status + every timer/watch).
//
// Every instant is a fixed epoch-ms vector; no real timers, no I/O, no
// network, no ~/.omp.

import { describe, expect, it } from "vitest";
import { scheduleFromSpans } from "../lib/window";
import type { Currency, PricingCache, PricingData } from "../lib/pricing";
import type { SessionCost } from "../lib/cost";
import type { SessionLedger } from "../lib/usage";
import type { BalanceRow, FetchBalanceResult } from "../lib/balance";
import { DEFAULT_CONFIG, type Config } from "../lib/config";
import { renderStatusText } from "../lib/render";
import {
  createStatuslineController,
  type StatuslineEnv,
  type StatuslineModel,
  type StatuslineSession,
} from "../lib/statusline";

// ─── fixed fixtures ─────────────────────────────────────────────────────────

const MIN = 60_000;

/** Mon 2026-09-07 00:50:00Z — off-peak (canonical schedule), next boundary Mon 01:00 (10m 0s). */
const BASE = Date.UTC(2026, 8, 7, 0, 50, 0);

const CWD = "/repo";
const DEEPSEEK: StatuslineModel = { id: "deepseek-v4-flash", provider: "deepseek" };
const CODEX: StatuslineModel = { id: "claude-sonnet-4-5", provider: "anthropic" };

/** Canonical Mon–Fri 01:00–04:00 + 06:00–10:00 UTC schedule (window.ts shape). */
const CANONICAL = scheduleFromSpans([
  { weekdays: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
  { weekdays: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
]);

/** CNY zh-cn-style rows for the two v4 models (off-peak half of peak). */
const CNY_TABLE: PricingData = {
  currency: "CNY",
  models: {
    "deepseek-v4-flash": {
      peak: { inHit: 0.1, inMiss: 3, out: 9 },
      offPeak: { inHit: 0.05, inMiss: 1.5, out: 4.5 },
    },
    "deepseek-v4-pro": {
      peak: { inHit: 0.3, inMiss: 9, out: 27 },
      offPeak: { inHit: 0.15, inMiss: 4.5, out: 13.5 },
    },
  },
  schedule: CANONICAL,
};

/** USD en-page-style table (one model row is enough for symbol checks). */
const USD_TABLE: PricingData = {
  currency: "USD",
  models: {
    "deepseek-v4-flash": {
      peak: { inHit: 0.01, inMiss: 0.3, out: 0.9 },
      offPeak: { inHit: 0.005, inMiss: 0.15, out: 0.45 },
    },
  },
  schedule: CANONICAL,
};

const CNY_BALANCE: BalanceRow = { currency: "CNY", totalBalance: 110 };
const USD_BALANCE: BalanceRow = { currency: "USD", totalBalance: 12.34 };

const cacheEntry = (data: PricingData): PricingCache["entries"][Currency] => ({
  fetchedAt: new Date(BASE).toISOString(),
  data,
});

function cfg(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, timezone: "UTC", ...over };
}

function usedLedger(
  sessionId: string,
  opts: { cwd?: string; startTs?: number; lastTs?: number; cacheMiss?: number } = {},
): SessionLedger {
  return {
    sessionId,
    cwd: opts.cwd ?? CWD,
    startTs: opts.startTs ?? BASE - 30_000,
    lastTs: opts.lastTs ?? BASE,
    buckets:
      (opts.cacheMiss ?? 0) > 0
        ? [{ modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 0, cacheMiss: opts.cacheMiss!, output: 0 }]
        : [],
  };
}

// ─── fake clock + timers ────────────────────────────────────────────────────

interface TimeoutRec {
  id: number;
  at: number;
  cb: () => void;
  alive: boolean;
}
interface IntervalRec {
  id: number;
  nextAt: number;
  ms: number;
  cb: () => void;
  alive: boolean;
}

/** Deterministic fake timers: advance(ms) runs every due timer in time order. */
class FakeClock {
  now: number;
  private timeouts: TimeoutRec[] = [];
  private intervals: IntervalRec[] = [];
  private nextId = 1;

  constructor(startMs: number) {
    this.now = startMs;
  }

  setTimeout(cb: () => void, ms: number): number {
    const rec: TimeoutRec = { id: this.nextId++, at: this.now + ms, cb, alive: true };
    this.timeouts.push(rec);
    return rec.id;
  }

  clearTimeout(id: number): void {
    const rec = this.timeouts.find((t) => t.id === id);
    if (rec) rec.alive = false;
  }

  setInterval(cb: () => void, ms: number): number {
    const rec: IntervalRec = { id: this.nextId++, nextAt: this.now + ms, ms, cb, alive: true };
    this.intervals.push(rec);
    return rec.id;
  }

  clearInterval(id: number): void {
    const rec = this.intervals.find((t) => t.id === id);
    if (rec) rec.alive = false;
  }

  get pending(): number {
    return this.timeouts.filter((t) => t.alive).length + this.intervals.filter((t) => t.alive).length;
  }

  /** Run every timer due within [now, now+ms] in time order; then now = now+ms. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (let guard = 0; guard < 100_000; guard += 1) {
      let dueAt = Number.POSITIVE_INFINITY;
      let interval = false;
      for (const t of this.timeouts) {
        if (t.alive && t.at < dueAt) {
          dueAt = t.at;
          interval = false;
        }
      }
      for (const i of this.intervals) {
        if (i.alive && i.nextAt < dueAt) {
          dueAt = i.nextAt;
          interval = true;
        }
      }
      if (dueAt > target) break;
      this.now = dueAt;
      if (interval) {
        const rec = this.intervals.find((i) => i.alive && i.nextAt === dueAt)!;
        rec.cb();
        rec.nextAt += rec.ms;
        if (rec.nextAt <= this.now) rec.nextAt = this.now + rec.ms;
      } else {
        const rec = this.timeouts.find((t) => t.alive && t.at === dueAt)!;
        rec.alive = false;
        rec.cb();
      }
    }
    this.now = target;
  }
}

/** Drain the microtask queue (env doubles resolve without real waits). */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

/** Settle every chain started by startSession: immediate balance tick + microtasks. */
async function settle(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    clock.advance(0);
    await flush();
  }
}

// ─── controller harness (mocked ctx.ui.setStatus + env doubles) ─────────────

interface HarnessState {
  ledgers: SessionLedger[];
  cache: PricingCache;
  balance: FetchBalanceResult;
  key: string | undefined;
  pricing: Partial<
    Record<Currency, { ok: true; data: PricingData } | { ok: false; error: string }>
  >;
}

interface Harness {
  clock: FakeClock;
  controller: ReturnType<typeof createStatuslineController>;
  session: StatuslineSession;
  calls: {
    statuses: (string | undefined)[];
    balanceFetches: number;
    pricingFetches: Currency[];
    ledgerSaves: SessionLedger[];
    cacheSaves: number;
    keyProviders: string[];
    errors: unknown[];
  };
  state: HarnessState;
  triggerWatch(fileName: string | null): void;
  watcherClosed(): boolean;
  lastStatus(): string | undefined;
}

function makeHarness(opts: { model?: StatuslineModel | null } = {}): Harness {
  const clock = new FakeClock(BASE);
  const calls = {
    statuses: [] as (string | undefined)[],
    balanceFetches: 0,
    pricingFetches: [] as Currency[],
    ledgerSaves: [] as SessionLedger[],
    cacheSaves: 0,
    keyProviders: [] as string[],
    errors: [] as unknown[],
  };
  const state: HarnessState = {
    ledgers: [] as SessionLedger[],
    cache: { entries: {} } as PricingCache,
    balance: { ok: true, rows: [CNY_BALANCE] } as FetchBalanceResult,
    key: "sk-test" as string | undefined,
    pricing: { CNY: { ok: true, data: CNY_TABLE }, USD: { ok: true, data: USD_TABLE } },
  };
  let watchCb: ((fileName: string | null) => void) | null = null;
  let watcherClosed = false;

  const env: StatuslineEnv = {
    now: () => clock.now,
    setInterval: (cb, ms) => clock.setInterval(cb, ms),
    clearInterval: (handle) => clock.clearInterval(handle as number),
    setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle as number),
    loadLedgers: async () => [...state.ledgers],
    saveLedger: async (ledger) => {
      calls.ledgerSaves.push(ledger);
    },
    watchLedgerDir: (cb) => {
      watchCb = cb;
      return () => {
        watcherClosed = true;
      };
    },
    loadPricingCache: async () => state.cache,
    savePricingCache: async () => {
      calls.cacheSaves += 1;
    },
    fetchPricing: async (currency) => {
      calls.pricingFetches.push(currency);
      const res = state.pricing[currency];
      return res ?? { ok: false, error: "no table configured" };
    },
    fetchBalance: async () => {
      calls.balanceFetches += 1;
      return state.balance;
    },
    resolveApiKey: async (provider) => {
      calls.keyProviders.push(provider);
      return state.key;
    },
    reportError: (err) => {
      calls.errors.push(err);
    },
  };
  const controller = createStatuslineController(env);
  const session: StatuslineSession = {
    sessionId: "main-1",
    cwd: CWD,
    model: opts.model === undefined ? DEEPSEEK : opts.model,
    setStatus: (text) => {
      calls.statuses.push(text);
    },
  };
  return {
    clock,
    controller,
    session,
    calls,
    state,
    triggerWatch: (fileName) => watchCb?.(fileName),
    watcherClosed: () => watcherClosed,
    lastStatus: () => calls.statuses[calls.statuses.length - 1],
  };
}

// ─── expected-string helpers (derived from the fixed fixtures above) ────────

const WINDOW_10M = "◐ off-peak →peak 01:00 in 10m 0s";
/** Off-peak CNY rows — only the ACTIVE model's row renders. */
const PRICE_FLASH_CNY = "v4-flash ¥1.5m/¥0.05h/¥4.5o"; // active deepseek-v4-flash
const PRICE_PRO_CNY = "v4-pro ¥4.5m/¥0.15h/¥13.5o"; // active deepseek-v4-pro
const BAL_CNY = "bal ¥110.00";
const SESSION_ZERO_CNY = "session ¥0.00";

const lineAtBase = (session: string, opts: { balance?: string | null } = {}): string => {
  const parts = [WINDOW_10M, PRICE_FLASH_CNY];
  if (opts.balance !== null) parts.push(opts.balance ?? BAL_CNY);
  parts.push(session);
  return parts.join(" | ");
};

// ═══════════════════════════════════════════════════════════════════════════
// Renderer (lib/render) — exact strings
// ═══════════════════════════════════════════════════════════════════════════

describe("renderStatusText", () => {
  it("renders the SPEC example line byte-for-byte (off-peak, CNY, countdown 5h 12m)", () => {
    // Sun 2026-09-06 19:48 UTC is off-peak; the next boundary is Mon 01:00 UTC
    // (5h 12m away) → 09:00 in Asia/Shanghai. The single price row rendered is
    // the ACTIVE model's (deepseek-v4-flash).
    const table: PricingData = {
      currency: "CNY",
      models: {
        "deepseek-v4-flash": {
          peak: { inHit: 0.1, inMiss: 3, out: 9 },
          offPeak: { inHit: 0.05, inMiss: 1.5, out: 4.5 },
        },
        "deepseek-v4-pro": {
          peak: { inHit: 0.3, inMiss: 9, out: 27 },
          offPeak: { inHit: 0.15, inMiss: 4.5, out: 13.5 },
        },
      },
      schedule: scheduleFromSpans([{ weekdays: [1], start: "01:00", end: "05:00" }]),
    };
    const now = Date.UTC(2026, 8, 6, 19, 48, 0);
    const cost: SessionCost = { total: 2.31, unpricedTokens: 0 };
    expect(
      renderStatusText({
        nowMs: now,
        timezone: "Asia/Shanghai",
        pricing: table,
        activeModelId: "deepseek-v4-flash",
        balance: { kind: "ok", currency: "CNY", total: 110 },
        sessionCost: cost,
      }),
    ).toBe(
      "◐ off-peak →peak 09:00 in 5h 12m | v4-flash ¥1.5m/¥0.05h/¥4.5o | bal ¥110.00 | session ¥2.31",
    );
  });

  it("renders peak state with the ● glyph, peak rows, and the span-end boundary", () => {
    // Mon 03:00 UTC — inside the first peak span; next boundary 04:00 (1h 0m).
    const now = Date.UTC(2026, 8, 7, 3, 0, 0);
    expect(
      renderStatusText({
        nowMs: now,
        timezone: "UTC",
        pricing: CNY_TABLE,
        activeModelId: "deepseek-v4-flash",
        balance: null,
        sessionCost: { total: 0, unpricedTokens: 0 },
      }),
    ).toBe(
      "● peak →off-peak 04:00 in 1h 0m | v4-flash ¥3m/¥0.1h/¥9o | session ¥0.00",
    );
  });

  it("renders exactly one row — the active model's — never a sibling or a separator", () => {
    const table: PricingData = {
      currency: "CNY",
      models: {
        "deepseek-v4-flash": CNY_TABLE.models["deepseek-v4-flash"],
        "deepseek-v4-flash-vision-exp": {
          peak: { inHit: 0.1, inMiss: 3, out: 9 },
          offPeak: { inHit: 0.05, inMiss: 1.5, out: 4.5 },
        },
      },
      schedule: CANONICAL,
    };
    const text = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: table,
      activeModelId: "deepseek-v4-flash-vision-exp",
      balance: null,
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(text).toBe(
      `${WINDOW_10M} | v4-flash-vision-exp ¥1.5m/¥0.05h/¥4.5o | session ¥0.00`,
    );
  });

  it("renders ONLY the active model's row (pro active → its row, flash absent)", () => {
    const text = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-v4-pro",
      balance: null,
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(text).toBe(`${WINDOW_10M} | ${PRICE_PRO_CNY} | session ¥0.00`);
  });

  it("omits the price segment when no DeepSeek model is active (null id) or the active id has no fetched row", () => {
    // Null active id — e.g. a Codex main pinned visible by alwaysShow, or
    // visibility from subagent ledgers with no main-session attribution.
    const noModel = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: null,
      balance: { kind: "ok", currency: "CNY", total: 110 },
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(noModel).toBe(`${WINDOW_10M} | ${BAL_CNY} | session ¥0.00`);
    // A legacy id absent from the fetched table: same drop, never another row.
    const legacy = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-chat",
      balance: { kind: "ok", currency: "CNY", total: 110 },
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(legacy).toBe(`${WINDOW_10M} | ${BAL_CNY} | session ¥0.00`);
  });

  it("degrades to `prices unavailable` and `session n/a` before any pricing fetch", () => {
    expect(
      renderStatusText({
        nowMs: BASE,
        timezone: "UTC",
        pricing: null,
        activeModelId: null,
        balance: { kind: "ok", currency: "CNY", total: 110 },
        sessionCost: null,
      }),
    ).toBe("prices unavailable | bal ¥110.00 | session n/a");
  });

  it("renders `session n/a` when pricing exists but no cost has been computed", () => {
    const text = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-v4-flash",
      balance: null,
      sessionCost: null,
    });
    expect(text).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session n/a`);
  });

  it("renders `bal ✕` for an unauthorized balance and omits the balance segment entirely for no-auth", () => {
    const withX = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-v4-flash",
      balance: { kind: "unauthorized" },
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(withX).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | bal ✕ | session ¥0.00`);

    const omitted = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-v4-flash",
      balance: null,
      sessionCost: { total: 0, unpricedTokens: 0 },
    });
    expect(omitted).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥0.00`);
  });

  it("appends an exact `+N unpriced` segment when the session carries unpriced tokens", () => {
    const text = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: CNY_TABLE,
      activeModelId: "deepseek-v4-flash",
      balance: { kind: "ok", currency: "CNY", total: 110 },
      sessionCost: { total: 2.31, unpricedTokens: 1234 },
    });
    expect(text).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | ${BAL_CNY} | session ¥2.31 | +1234 unpriced`);
  });

  it("renders USD with $ symbols and two-decimal balance/cost", () => {
    const text = renderStatusText({
      nowMs: BASE,
      timezone: "UTC",
      pricing: USD_TABLE,
      activeModelId: "deepseek-v4-flash",
      balance: { kind: "ok", currency: "USD", total: 12.34 },
      sessionCost: { total: 0.45, unpricedTokens: 0 },
    });
    expect(text).toBe(
      "◐ off-peak →peak 01:00 in 10m 0s | v4-flash $0.15m/$0.005h/$0.45o | bal $12.34 | session $0.45",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Controller (lib/statusline) — orchestration behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("createStatuslineController", () => {
  it("renders synchronously at session_start when a DeepSeek model is active (visibility + immediate balance)", async () => {
    const h = makeHarness();
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    expect(h.lastStatus()).toBe("prices unavailable | session n/a"); // sync, before caches load
    await settle(h.clock);
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY));
    expect(h.calls.balanceFetches).toBe(1); // immediate refresh on visibility gain
    expect(h.calls.keyProviders).toEqual(["deepseek"]);
  });

  it("calls setStatus synchronously after every DeepSeek usage event (per turn and per tool-call step)", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    h.calls.statuses.length = 0;

    // Turn 1 (e.g. assistant message of a turn).
    h.controller.messageEnd({
      ts: BASE + 5_000,
      model: DEEPSEEK,
      sessionModel: DEEPSEEK,
      input: 1_000_000,
    });
    expect(h.lastStatus()).toBe(lineAtBase("session ¥1.50")); // 1e6 miss × ¥1.5/m

    // Tool-call step of the same turn.
    h.controller.messageEnd({
      ts: BASE + 6_000,
      model: DEEPSEEK,
      sessionModel: DEEPSEEK,
      output: 500_000,
    });
    expect(h.lastStatus()).toBe(lineAtBase("session ¥3.75")); // + 5e5 out × ¥4.5/m

    // No balance/pricing work was triggered by usage events themselves.
    expect(h.calls.balanceFetches).toBe(1);
    expect(h.calls.pricingFetches).toHaveLength(0);

    // The ledger save is debounced (≤1 s): nothing at +500 ms, once at +1 s.
    h.clock.advance(500);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(0);
    h.clock.advance(500);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(1);
    const saved = h.calls.ledgerSaves[0];
    expect(saved.sessionId).toBe("main-1");
    expect(saved.cwd).toBe(CWD);
    expect(saved.buckets).toEqual([
      { modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 0, cacheMiss: 1_000_000, output: 500_000 },
    ]);
  });

  it("ignores non-DeepSeek usage (Codex messages never accumulate or show)", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    h.calls.statuses.length = 0;

    h.controller.messageEnd({
      ts: BASE + 2_000,
      model: CODEX,
      sessionModel: CODEX,
      input: 999_999,
    });
    expect(h.calls.statuses).toHaveLength(0); // nothing rendered, nothing accumulated
    h.clock.advance(1_000);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(0);
  });

  it("attributes a DeepSeek message to its own model when ctx.model stays Codex (fallback without a ctx flip)", async () => {
    const h = makeHarness({ model: CODEX }); // Codex main; ctx.model never flips
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.statuses).toHaveLength(0); // hidden: Codex session

    // Fallback request served by DeepSeek while ctx.model still reports Codex:
    // the MESSAGE's model is the per-request truth, so it becomes visible with
    // the flash row and the usage is bucketed under deepseek-v4-flash.
    h.controller.messageEnd({
      ts: BASE + 2_000,
      model: DEEPSEEK,
      sessionModel: CODEX,
      input: 1_000_000,
    });
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥1.50`); // sync, pre-balance
    await settle(h.clock);
    expect(h.lastStatus()).toBe(lineAtBase("session ¥1.50")); // balance now present
    expect(h.calls.keyProviders).toEqual(["deepseek"]); // provider from the message model

    h.clock.advance(1_000);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(1);
    expect(h.calls.ledgerSaves[0].buckets).toEqual([
      { modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 0, cacheMiss: 1_000_000, output: 0 },
    ]);
  });

  it("never charges a non-DeepSeek message to the DeepSeek session model (Codex fallback under a DeepSeek main)", async () => {
    const h = makeHarness(); // DeepSeek main (session.model)
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY)); // visible: DeepSeek main
    h.calls.statuses.length = 0;

    // A Codex-produced message while ctx.model reads DeepSeek is NOT DeepSeek
    // work: the per-request model is present and non-DeepSeek, so the session
    // model must not override it into usage.
    h.controller.messageEnd({
      ts: BASE + 2_000,
      model: CODEX,
      sessionModel: DEEPSEEK,
      input: 999_999,
    });
    expect(h.calls.statuses).toHaveLength(0); // no render on a non-DeepSeek event
    h.clock.advance(1_000);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(0); // nothing accumulated, nothing written
    // The session stays visible via its own DeepSeek ctx.model (clause b)…
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY).replace("in 10m 0s", "in 9m 59s"));
    // …but the Codex tokens never touch the DeepSeek cost.
    expect(h.lastStatus()).toContain("session ¥0.00");
  });

  it("falls back to the DeepSeek session model only when the runtime message carries no model", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    h.calls.statuses.length = 0;

    // No per-request model field on the event: ctx.model is the only signal.
    h.controller.messageEnd({
      ts: BASE + 3_000,
      model: null,
      sessionModel: DEEPSEEK,
      input: 1_000_000,
    });
    expect(h.lastStatus()).toBe(lineAtBase("session ¥1.50")); // session-model attribution
    h.clock.advance(1_000);
    await flush();
    expect(h.calls.ledgerSaves).toHaveLength(1);
    expect(h.calls.ledgerSaves[0].buckets).toEqual([
      { modelId: "deepseek-v4-flash", phase: "offPeak", cacheHit: 0, cacheMiss: 1_000_000, output: 0 },
    ]);
  });

  it("updates ONLY the countdown digits on 1 s ticks — no fetch, no save, no re-render of other segments", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    const before = h.lastStatus();
    expect(before).toBe(lineAtBase(SESSION_ZERO_CNY));

    const fetchesAfterStart = h.calls.balanceFetches;
    h.calls.statuses.length = 0;

    h.clock.advance(1_000);
    expect(h.calls.statuses).toHaveLength(1);
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY).replace("in 10m 0s", "in 9m 59s"));

    h.clock.advance(1_000);
    h.clock.advance(1_000);
    expect(h.calls.statuses).toHaveLength(3);
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY).replace("in 10m 0s", "in 9m 57s"));

    // Ticks only re-render the countdown: no new balance/pricing fetches, no saves.
    expect(h.calls.balanceFetches).toBe(fetchesAfterStart);
    expect(h.calls.pricingFetches).toHaveLength(0);
    expect(h.calls.ledgerSaves).toHaveLength(0);
    expect(h.calls.cacheSaves).toBe(0);
  });

  it("stays hidden for a pure-Codex session — zero fetches while hidden", async () => {
    const h = makeHarness({ model: CODEX });
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.statuses).toHaveLength(0);
    h.clock.advance(60_000); // 60 ticks + scans
    await flush();
    expect(h.calls.statuses).toHaveLength(0);
    expect(h.calls.balanceFetches).toBe(0);
    expect(h.calls.pricingFetches).toHaveLength(0);
    expect(h.calls.ledgerSaves).toHaveLength(0);
  });

  it("becomes visible on a DeepSeek fallback message even under a Codex main, and hides again when the model returns before any usage", async () => {
    const h = makeHarness({ model: CODEX });
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.statuses).toHaveLength(0); // hidden: Codex main

    // Mid-session fallback: a DeepSeek assistant message arrives (ctx.model flips).
    h.controller.messageEnd({
      ts: BASE + 1_000,
      model: DEEPSEEK,
      sessionModel: DEEPSEEK,
      input: 1_000_000,
    });
    // Visible synchronously; the balance refresh kicked by the visibility gain is async.
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥1.50`);
    await settle(h.clock);
    expect(h.lastStatus()).toBe(lineAtBase("session ¥1.50")); // balance now present

    // Now a fresh session whose model flips back to Codex BEFORE any usage: hides on the next tick.
    const h2 = makeHarness();
    h2.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h2.controller.setConfig(cfg());
    h2.controller.startSession(h2.session);
    await settle(h2.clock);
    expect(h2.lastStatus()).not.toBeUndefined();
    h2.calls.statuses.length = 0;
    h2.controller.messageEnd({ ts: BASE + 1_000, model: CODEX, sessionModel: CODEX });
    expect(h2.calls.statuses).toHaveLength(0); // no render on a non-DeepSeek event
    h2.clock.advance(1_000); // next tick evaluates visibility → hidden
    expect(h2.lastStatus()).toBeUndefined();
  });

  it("pins visible with alwaysShow even for a Codex-only session", async () => {
    const h = makeHarness({ model: CODEX });
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg({ alwaysShow: true }));
    h.controller.startSession(h.session);
    await settle(h.clock);
    // Codex main pinned by alwaysShow → no active DeepSeek model → no price row.
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${BAL_CNY} | ${SESSION_ZERO_CNY}`);
  });

  it("refreshes the balance every balanceRefreshSec while visible (15 s default) and not in between", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.balanceFetches).toBe(1);

    h.clock.advance(10_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(1); // not yet due

    h.clock.advance(5_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(2);

    h.clock.advance(15_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(3);
  });

  it("retries an unauthorized balance only after balanceRetrySec (default 300 s) and renders bal ✕", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.state.balance = { ok: false, kind: "unauthorized" };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.balanceFetches).toBe(1);
    expect(h.lastStatus()).toContain("bal ✕");

    h.clock.advance(15_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(1); // not at the normal refresh cadence

    h.clock.advance(285_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(2); // retried after balanceRetrySec
  });

  it("keeps the last balance rows silently on a network error", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.lastStatus()).toContain(BAL_CNY);

    h.state.balance = { ok: false, kind: "network", error: "fetch failed: down" };
    h.clock.advance(15_000);
    await flush();
    expect(h.calls.balanceFetches).toBe(2);
    expect(h.lastStatus()).toContain(BAL_CNY); // stale value kept
    expect(h.lastStatus()).not.toContain("bal ✕");
  });

  it("omits the balance segment entirely when no auth key resolves (never bal ✕, no fetch)", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.state.key = undefined;
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.balanceFetches).toBe(0);
    expect(h.calls.statuses.some((s) => s !== undefined && s.includes("bal"))).toBe(false);
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥0.00`);
  });

  it("fetches the pricing table once per needed currency only when visible, and serves any cached age with zero fetches", async () => {
    // No cache + visible → exactly one fetch of the auto (CNY) currency.
    const h = makeHarness();
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.pricingFetches).toEqual(["CNY"]);
    expect(h.lastStatus()).toContain("v4-flash");
    expect(h.calls.cacheSaves).toBe(1);

    // Cached entry of any age → zero fetches.
    const h2 = makeHarness();
    h2.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h2.controller.setConfig(cfg());
    h2.controller.startSession(h2.session);
    await settle(h2.clock);
    expect(h2.calls.pricingFetches).toHaveLength(0);
  });

  it("flips auto display currency to USD when the first balance row is USD-only and fetches the USD table", async () => {
    const h = makeHarness();
    h.state.balance = { ok: true, rows: [USD_BALANCE] }; // USD-only account arrives late
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    // CNY is the auto default before any balance rows exist → CNY fetched first,
    // then the USD-only balance flips auto to USD → USD fetched.
    expect(h.calls.pricingFetches).toEqual(["CNY", "USD"]);
    expect(h.lastStatus()).toBe(
      "◐ off-peak →peak 01:00 in 10m 0s | v4-flash $0.15m/$0.005h/$0.45o | bal $12.34 | session $0.00",
    );
  });

  it("shows `prices unavailable` on first-fetch failure and retries at most every 5 minutes while visible", async () => {
    const h = makeHarness();
    h.state.balance = { ok: true, rows: [CNY_BALANCE] };
    h.state.pricing.CNY = { ok: false, error: "net down" };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.pricingFetches).toEqual(["CNY"]);
    expect(h.lastStatus()).toBe(`prices unavailable | ${BAL_CNY} | session n/a`);
    expect(h.calls.cacheSaves).toBe(0);

    h.state.pricing.CNY = { ok: true, data: CNY_TABLE };
    h.clock.advance(299_000);
    await flush();
    expect(h.calls.pricingFetches).toHaveLength(1); // retry ceiling not reached

    h.clock.advance(1_000);
    await flush();
    expect(h.calls.pricingFetches).toEqual(["CNY", "CNY"]); // retried after 5 min
    expect(h.calls.cacheSaves).toBe(1);
    // Clock is now BASE + 5 min (00:55) — the countdown reads 5m 0s.
    expect(h.lastStatus()).toBe(
      lineAtBase(SESSION_ZERO_CNY).replace("in 10m 0s", "in 5m 0s"),
    );
  });

  it("folds a DeepSeek subagent ledger seen via the ledger-dir watch into the tree cost (and excludes foreign cwd)", async () => {
    const h = makeHarness({ model: CODEX }); // Codex main: hidden until the subagent ledger lands
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.state.key = undefined;
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.statuses).toHaveLength(0); // hidden

    h.state.ledgers = [usedLedger("sub-1", { cacheMiss: 2_000_000 })]; // ¥3.00 in the tree
    h.triggerWatch("ledger-sub-1.json");
    await flush();
    // Visible ≤ watch tick; the price row derives from the subagent's model.
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥3.00`);

    // A foreign-cwd ledger must NOT fold into this tree's cost.
    h.state.ledgers = [
      usedLedger("sub-1", { cacheMiss: 2_000_000 }),
      usedLedger("sub-2", { cwd: "/other", cacheMiss: 1_000_000 }),
    ];
    h.triggerWatch("ledger-sub-2.json");
    await flush();
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_FLASH_CNY} | session ¥3.00`); // unchanged
  });

  it("shows the subagent's own model row when a DeepSeek pro subagent runs under a Codex main", async () => {
    const h = makeHarness({ model: CODEX });
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.state.key = undefined;
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.statuses).toHaveLength(0); // hidden: no usage yet

    // Pro subagent: 2M cache-miss tokens, priced at pro off-peak (¥4.5/1M) = ¥9.00.
    const proLedger: SessionLedger = {
      sessionId: "sub-pro",
      cwd: CWD,
      startTs: BASE - 30_000,
      lastTs: BASE,
      buckets: [
        { modelId: "deepseek-v4-pro", phase: "offPeak", cacheHit: 0, cacheMiss: 2_000_000, output: 0 },
      ],
    };
    h.state.ledgers = [proLedger];
    h.triggerWatch("ledger-sub-pro.json");
    await flush();
    expect(h.lastStatus()).toBe(`${WINDOW_10M} | ${PRICE_PRO_CNY} | session ¥9.00`);
  });

  it("clears the status and stops every timer/watch on session shutdown; late events are ignored", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.lastStatus()).toBe(lineAtBase(SESSION_ZERO_CNY));
    expect(h.clock.pending).toBeGreaterThan(0); // ticker + scan + balance chain

    h.controller.shutdown();
    expect(h.lastStatus()).toBeUndefined();
    expect(h.clock.pending).toBe(0);
    expect(h.watcherClosed()).toBe(true);

    const statusesAtShutdown = h.calls.statuses.length;
    h.controller.messageEnd({ ts: BASE + 1_000, model: DEEPSEEK, sessionModel: DEEPSEEK, input: 1 });
    await flush();
    expect(h.calls.statuses.length).toBe(statusesAtShutdown); // ignored: destroyed
    expect(h.calls.ledgerSaves).toHaveLength(0);
  });
});
