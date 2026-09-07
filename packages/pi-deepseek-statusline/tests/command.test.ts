// tests/command.test.ts — Task 10: the public forceRefreshPrices() semantics
// on the REAL controller (fake clock + env doubles, ported from
// tests/statusline.test.ts) and the /ds-statusline command flow
// (registration, flag paths, interactive single-pass menu, atomic
// persistence, exact notify strings) against a stub controller + temp config
// dir (temp-dir conventions from tests/config.test.ts).
//
// Hermetic: no network, no real ~/.omp, no real timers except the FakeClock,
// and every config path points into a per-test temp dir.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { scheduleFromSpans } from "../lib/window";
import type { Currency, PricingCache, PricingData } from "../lib/pricing";
import type { BalanceRow, FetchBalanceResult } from "../lib/balance";
import { DEFAULT_CONFIG, type Config } from "../lib/config";
import {
  createStatuslineController,
  type StatuslineController,
  type StatuslineEnv,
  type StatuslineModel,
  type StatuslineSession,
} from "../lib/statusline";
import { registerDsStatuslineCommand, type DsStatuslineCommandDeps } from "../lib/command";

// ─── fixed fixtures ─────────────────────────────────────────────────────────

const MIN = 60_000;

/** Mon 2026-09-07 00:50:00Z — off-peak (canonical schedule), next boundary Mon 01:00 (10m 0s). */
const BASE = Date.UTC(2026, 8, 7, 0, 50, 0);

const CWD = "/repo";
const DEEPSEEK: StatuslineModel = { id: "deepseek-v4-flash", provider: "deepseek" };

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

/** CNY table whose v4-flash off-peak output is ¥6 — clearly distinct render text. */
const CNY_FLASH_6: PricingData = {
  ...CNY_TABLE,
  models: {
    ...CNY_TABLE.models,
    "deepseek-v4-flash": {
      ...CNY_TABLE.models["deepseek-v4-flash"],
      offPeak: { ...CNY_TABLE.models["deepseek-v4-flash"].offPeak, out: 6 },
    },
  },
};

const CNY_BALANCE: BalanceRow = { currency: "CNY", totalBalance: 110 };

/** A cached entry of ANY age — fetch-once-keep-forever never re-fetches it. */
const cacheEntry = (data: PricingData): PricingCache["entries"][Currency] => ({
  fetchedAt: "2020-01-01T00:00:00.000Z",
  data,
});

function cfg(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, timezone: "UTC", ...over };
}

// ─── fake clock + timers (ported from tests/statusline.test.ts) ─────────────

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

// ─── real-controller harness (env doubles, ported from statusline.test.ts) ──

interface HarnessState {
  cache: PricingCache;
  balance: FetchBalanceResult;
  key: string | undefined;
  pricing: Partial<
    Record<Currency, { ok: true; data: PricingData } | { ok: false; error: string }>
  >;
}

interface HarnessCalls {
  statuses: (string | undefined)[];
  pricingFetches: Currency[];
  cacheSaves: number;
  balanceFetches: number;
  errors: unknown[];
}

interface Harness {
  clock: FakeClock;
  controller: StatuslineController;
  session: StatuslineSession;
  state: HarnessState;
  calls: HarnessCalls;
  lastStatus(): string | undefined;
}

function makeHarness(opts: { model?: StatuslineModel | null } = {}): Harness {
  const clock = new FakeClock(BASE);
  const calls: HarnessCalls = {
    statuses: [],
    pricingFetches: [],
    cacheSaves: 0,
    balanceFetches: 0,
    errors: [],
  };
  const state: HarnessState = {
    cache: { entries: {} },
    balance: { ok: true, rows: [CNY_BALANCE] },
    key: "sk-test",
    pricing: { CNY: { ok: true, data: CNY_TABLE }, USD: { ok: true, data: USD_TABLE } },
  };
  const env: StatuslineEnv = {
    now: () => clock.now,
    setInterval: (cb, ms) => clock.setInterval(cb, ms),
    clearInterval: (handle) => clock.clearInterval(handle as number),
    setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle as number),
    loadLedgers: async () => [],
    saveLedger: async () => {},
    watchLedgerDir: () => () => undefined,
    loadPricingCache: async () => state.cache,
    savePricingCache: async () => {
      calls.cacheSaves += 1;
    },
    fetchPricing: async (currency) => {
      calls.pricingFetches.push(currency);
      return state.pricing[currency] ?? { ok: false, error: "no table configured" };
    },
    fetchBalance: async () => {
      calls.balanceFetches += 1;
      return state.balance;
    },
    resolveApiKey: async () => state.key,
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
    state,
    calls,
    lastStatus: () => calls.statuses[calls.statuses.length - 1],
  };
}

// ─── command-flow doubles (stub controller, fake UI, temp config dir) ───────

type AnyMock = ReturnType<typeof vi.fn>;

interface FakeUi {
  notify: AnyMock;
  select: AnyMock;
  input: AnyMock;
  askDialog?: AnyMock;
}

/** notify/select/input are always vi.fn(); askDialog is absent unless provided. */
function fakeUi(over: Partial<FakeUi> = {}): FakeUi {
  return { notify: vi.fn(), select: vi.fn(), input: vi.fn(), ...over };
}

function fakeCtx(ui: FakeUi): ExtensionCommandContext {
  return { ui, hasUI: true } as unknown as ExtensionCommandContext;
}

/** Stub controller exposing its mocks for direct assertions. */
function stubController(): {
  controller: StatuslineController;
  forceRefreshPrices: AnyMock;
  setConfig: AnyMock;
} {
  const forceRefreshPrices = vi.fn();
  const setConfig = vi.fn();
  const controller = { forceRefreshPrices, setConfig } as unknown as StatuslineController;
  return { controller, forceRefreshPrices, setConfig };
}

function depsFor(file: string, controller: StatuslineController | undefined): DsStatuslineCommandDeps {
  return { configFile: file, controllerFor: () => controller };
}

interface CapturedCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** Registers through a capture double and returns what registerCommand received. */
function captureRegistration(deps: DsStatuslineCommandDeps): CapturedCommand {
  let captured: CapturedCommand | undefined;
  const pi = {
    registerCommand: (
      name: string,
      options: { description?: string; handler: CapturedCommand["handler"] },
    ): void => {
      captured = { name, ...options };
    },
  } as unknown as ExtensionAPI;
  registerDsStatuslineCommand(pi, deps);
  if (captured === undefined) throw new Error("registerCommand was not called");
  return captured;
}

/** An askDialog "submit" result selecting one option label. */
function submit(label: string): {
  kind: "submit";
  results: Array<{
    id: string;
    question: string;
    options: string[];
    selectedOptions: string[];
    multi: boolean;
  }>;
} {
  return {
    kind: "submit",
    results: [{ id: "action", question: "", options: [], selectedOptions: [label], multi: false }],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ds-statusline-command-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// controller.forceRefreshPrices() — real-controller semantics
// ═══════════════════════════════════════════════════════════════════════════

describe("controller.forceRefreshPrices", () => {
  it("refreshes every cached currency once, atomically overwrites, and re-renders the fresh prices", async () => {
    const h = makeHarness();
    h.state.cache = {
      entries: { CNY: cacheEntry(CNY_TABLE), USD: cacheEntry(USD_TABLE) },
    };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.pricingFetches).toEqual([]); // cache served — the auto path did nothing
    expect(h.calls.cacheSaves).toBe(0);

    h.state.pricing.CNY = { ok: true, data: CNY_FLASH_6 };
    const res = await h.controller.forceRefreshPrices();

    expect(res).toEqual({ ok: true, refreshed: ["CNY", "USD"] }); // union order: on-disk key order
    expect(h.calls.pricingFetches).toEqual(["CNY", "USD"]); // exactly one fetch per currency
    expect(h.calls.cacheSaves).toBe(1); // atomic overwrite persisted once
    expect(h.lastStatus()).toContain("¥6o"); // re-rendered with the refreshed CNY data

    // A manual refresh never serves stale in-memory data: a second call re-fetches.
    await h.controller.forceRefreshPrices();
    expect(h.calls.pricingFetches).toEqual(["CNY", "USD", "CNY", "USD"]);
    expect(h.calls.cacheSaves).toBe(2);
  });

  it("fails the whole refresh on any fetch failure and keeps the old cache untouched", async () => {
    const h = makeHarness();
    h.state.cache = { entries: { CNY: cacheEntry(CNY_TABLE) } };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.lastStatus()).toContain("¥4.5o"); // the OLD cached price is shown

    h.state.pricing.CNY = { ok: false, error: "net down" };
    const res = await h.controller.forceRefreshPrices();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("CNY");
      expect(res.error).toContain("net down");
    }
    expect(h.calls.pricingFetches).toEqual(["CNY"]); // exactly one attempt
    expect(h.calls.cacheSaves).toBe(0); // nothing saved on failure
    expect(h.lastStatus()).toContain("¥4.5o"); // old entries kept and still rendered
  });

  it("fetches and persists the current display currency once when nothing is cached", async () => {
    const h = makeHarness();
    h.state.cache = { entries: {} };
    h.controller.setConfig(cfg());
    h.controller.startSession(h.session);
    await settle(h.clock);
    expect(h.calls.pricingFetches).toEqual(["CNY"]); // auto → CNY fetched by the visibility path
    h.calls.pricingFetches.length = 0;
    h.calls.cacheSaves = 0;

    const res = await h.controller.forceRefreshPrices();
    expect(res).toEqual({ ok: true, refreshed: ["CNY"] });
    expect(h.calls.pricingFetches).toEqual(["CNY"]); // exactly one additional fetch
    expect(h.calls.cacheSaves).toBe(1);
    expect(h.lastStatus()).toContain("v4-flash");
  });

  it("returns `no active session` and fetches nothing without a live session", async () => {
    const h = makeHarness(); // controller exists; no startSession → session null
    const res = await h.controller.forceRefreshPrices();
    expect(res).toEqual({ ok: false, error: "no active session" });
    expect(h.calls.pricingFetches).toEqual([]);
    expect(h.calls.cacheSaves).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// /ds-statusline command — registration, flag paths, interactive flow
// ═══════════════════════════════════════════════════════════════════════════

describe("registerDsStatuslineCommand", () => {
  it("registers ds-statusline with a description and a handler", () => {
    const { controller } = stubController();
    const captured = captureRegistration(depsFor(join(dir, "ds-statusline.yml"), controller));
    expect(captured.name).toBe("ds-statusline");
    expect(captured.description).toBeTypeOf("string");
    expect(captured.description!.length).toBeGreaterThan(0);
    expect(captured.handler).toBeTypeOf("function");
  });

  it("--force-refresh notifies `prices refreshed` on success", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, forceRefreshPrices } = stubController();
    forceRefreshPrices.mockResolvedValue({ ok: true, refreshed: ["CNY"] });
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi();

    await handler("--force-refresh", fakeCtx(ui));

    expect(forceRefreshPrices).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("prices refreshed"), "info");
  });

  it("--force-refresh notifies `refresh failed` with an error on failure", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, forceRefreshPrices } = stubController();
    forceRefreshPrices.mockResolvedValue({ ok: false, error: "CNY: net down" });
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi();

    await handler("--force-refresh", fakeCtx(ui));

    expect(forceRefreshPrices).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("refresh failed"), "error");
  });

  it("accepts `force-refresh` without dashes", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, forceRefreshPrices } = stubController();
    forceRefreshPrices.mockResolvedValue({ ok: true, refreshed: ["CNY"] });
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi();

    await handler("force-refresh", fakeCtx(ui));

    expect(forceRefreshPrices).toHaveBeenCalledTimes(1);
  });

  it("notifies the usage warning for an unknown argument and never touches the controller", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, forceRefreshPrices, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi();

    await handler("--bogus", fakeCtx(ui));

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/ds-statusline"),
      "warning",
    );
    expect(forceRefreshPrices).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
  });

  it("warns when no live controller exists for the session", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { handler } = captureRegistration(depsFor(file, undefined));
    const ui = fakeUi();

    await handler("", fakeCtx(ui));

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no active session"),
      "warning",
    );
    expect(readdirSync(dir)).toEqual([]); // nothing written
  });
});

// ─── interactive flow (temp config dir + stub controller) ───────────────────

describe("/ds-statusline interactive flow", () => {
  it("toggles always-show via askDialog: atomically persists, preserves the unknown key, notifies saved, applies via setConfig", async () => {
    const file = join(dir, "ds-statusline.yml");
    writeFileSync(file, "# my settings\ntimezone: UTC\ncustomThing: keep-me\n");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi({
      askDialog: vi.fn(async () => submit("Toggle always-show (currently off)")),
    });

    await handler("", fakeCtx(ui));

    expect(ui.notify).toHaveBeenCalledWith("deepseek-statusline: saved", "info");
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ alwaysShow: true }));
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: true",
        "alwaysShow: true",
        "timezone: UTC",
        "displayCurrency: auto",
        "balanceRefreshSec: 15",
        "balanceRetrySec: 300",
        "customThing: keep-me",
        "",
      ].join("\n"),
    );
    expect(readdirSync(dir)).toEqual(["ds-statusline.yml"]); // atomic: no temp left
  });

  it("changes display currency via askDialog then the select fallback", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi({
      askDialog: vi.fn(async () => submit("Change display currency (currently auto)")),
    });
    ui.select.mockResolvedValue("USD");

    await handler("", fakeCtx(ui));

    expect(ui.select).toHaveBeenCalledWith("Display currency", ["auto", "USD", "CNY"]);
    expect(ui.notify).toHaveBeenCalledWith("deepseek-statusline: saved", "info");
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ displayCurrency: "USD" }));
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: true",
        "alwaysShow: false",
        'timezone: ""',
        "displayCurrency: USD",
        "balanceRefreshSec: 15",
        "balanceRetrySec: 300",
        "",
      ].join("\n"),
    );
  });

  it("changes timezone via askDialog then input", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi({
      askDialog: vi.fn(async () => submit("Change timezone (currently system local)")),
    });
    ui.input.mockResolvedValue("Asia/Ho_Chi_Minh");

    await handler("", fakeCtx(ui));

    expect(ui.input).toHaveBeenCalledWith(
      "Timezone (IANA name; leave empty for system local time)",
      "system local",
    );
    expect(ui.notify).toHaveBeenCalledWith("deepseek-statusline: saved", "info");
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Asia/Ho_Chi_Minh" }));
    expect(readFileSync(file, "utf8")).toContain("timezone: Asia/Ho_Chi_Minh");
  });

  it("persists a valid balance refresh seconds value and rejects an invalid one without persisting", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi({
      askDialog: vi.fn(async () => submit("Change balance refresh seconds (currently 15)")),
    });
    ui.input.mockResolvedValueOnce("30");

    await handler("", fakeCtx(ui));

    expect(ui.notify).toHaveBeenCalledWith("deepseek-statusline: saved", "info");
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ balanceRefreshSec: 30 }));
    expect(readFileSync(file, "utf8")).toContain("balanceRefreshSec: 30");

    // Second pass: the file now reads 30 (label reflects it) and the input is invalid.
    const ui2 = fakeUi({
      askDialog: vi.fn(async () => submit("Change balance refresh seconds (currently 30)")),
    });
    ui2.input.mockResolvedValueOnce("abc");
    await handler("", fakeCtx(ui2));

    expect(ui2.notify).toHaveBeenCalledWith(
      "deepseek-statusline: balance refresh seconds must be a number \u2265 0",
      "warning",
    );
    expect(setConfig).toHaveBeenCalledTimes(1); // the invalid pass did not apply
    expect(readFileSync(file, "utf8")).toContain("balanceRefreshSec: 30");
    expect(readFileSync(file, "utf8")).not.toContain("abc");
  });

  it("does nothing when the ask dialog is cancelled", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi({
      askDialog: vi.fn(async () => undefined),
    });

    await handler("", fakeCtx(ui));

    expect(ui.notify).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("falls back to select when askDialog is unavailable and still persists", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));
    const ui = fakeUi(); // no askDialog → select fallback
    ui.select.mockResolvedValue("Change timezone (currently system local)");
    ui.input.mockResolvedValue("America/New_York");

    await handler("", fakeCtx(ui));

    expect(ui.select).toHaveBeenCalledWith("DeepSeek status line", [
      "Toggle always-show (currently off)",
      "Change timezone (currently system local)",
      "Change display currency (currently auto)",
      "Change balance refresh seconds (currently 15)",
      "Refresh official prices now",
      "Done",
    ]);
    expect(ui.notify).toHaveBeenCalledWith("deepseek-statusline: saved", "info");
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ timezone: "America/New_York" }));
    expect(readFileSync(file, "utf8")).toContain("timezone: America/New_York");
  });

  it("runs the refresh-prices-now action without persisting config (success, empty, failure)", async () => {
    const file = join(dir, "ds-statusline.yml");
    const { controller, forceRefreshPrices, setConfig } = stubController();
    const { handler } = captureRegistration(depsFor(file, controller));

    // Success with refreshed currencies.
    forceRefreshPrices.mockResolvedValueOnce({ ok: true, refreshed: ["CNY"] });
    const uiOk = fakeUi({
      askDialog: vi.fn(async () => submit("Refresh official prices now")),
    });
    await handler("", fakeCtx(uiOk));
    expect(uiOk.notify).toHaveBeenCalledWith(expect.stringContaining("prices refreshed"), "info");

    // Success with nothing cached.
    forceRefreshPrices.mockResolvedValueOnce({ ok: true, refreshed: [] });
    const uiEmpty = fakeUi({
      askDialog: vi.fn(async () => submit("Refresh official prices now")),
    });
    await handler("", fakeCtx(uiEmpty));
    expect(uiEmpty.notify).toHaveBeenCalledWith(
      "deepseek-statusline: no cached prices to refresh",
      "info",
    );

    // Failure.
    forceRefreshPrices.mockResolvedValueOnce({ ok: false, error: "CNY: net down" });
    const uiFail = fakeUi({
      askDialog: vi.fn(async () => submit("Refresh official prices now")),
    });
    await handler("", fakeCtx(uiFail));
    expect(uiFail.notify).toHaveBeenCalledWith(expect.stringContaining("refresh failed"), "error");

    // No config write or apply happened for any of the three outcomes.
    expect(forceRefreshPrices).toHaveBeenCalledTimes(3);
    expect(setConfig).not.toHaveBeenCalled();
    for (const u of [uiOk, uiEmpty, uiFail]) {
      expect(u.notify).not.toHaveBeenCalledWith(expect.stringContaining("saved"), "info");
      expect(u.select).not.toHaveBeenCalled();
      expect(u.input).not.toHaveBeenCalled();
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
