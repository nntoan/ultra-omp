// lib/statusline.ts — DeepSeek status-line controller. Orchestration only:
// every side effect (timers, ledger/pricing persistence, balance + pricing
// fetches, API-key resolution, file watching) arrives through the injected
// `StatuslineEnv`, so the controller is deterministic under fake timers and
// test doubles. No node: imports; nothing runs at module load.
//
// Responsibilities per session: fold main + subagent usage ledgers into the
// visible line, fetch-once per display currency with a retry ceiling while
// visible, balance cadence (balanceRefreshSec, retry after 401 at
// balanceRetrySec) that refreshes immediately on visibility gain, a 1 s
// ticker (only the countdown digits change between ticks), fs.watch plus a
// 10 s fallback scan for subagent ledgers, and debounced (≤1 s) ledger saves.
// session lifecycle: startSession begins the chains, shutdown clears the
// status and stops every timer/watch.

import { deepseekActive, isDeepSeekModel } from "./active";
import { balanceRowFor, resolveDisplayCurrency } from "./balance";
import type { BalanceRow, FetchBalanceResult } from "./balance";
import { DEFAULT_CONFIG, type Config } from "./config";
import { estimateSessionCost } from "./cost";
import type { Currency, PricingCache, PricingData } from "./pricing";
import { renderStatusText, type BalanceRenderState } from "./render";
import { addUsage, aggregateSessionTree, newLedger, type SessionLedger } from "./usage";

const TICK_MS = 1_000; // countdown ticker
const LEDGER_SCAN_MS = 10_000; // fallback scan while a session is live
const LEDGER_SAVE_DEBOUNCE_MS = 1_000;
const PRICING_RETRY_MS = 5 * 60_000; // first-fetch failure retry ceiling while visible

/** The whole outside world, injected by the wiring (or a test double). */
export interface StatuslineEnv {
  /** Epoch-ms wall clock. */
  now(): number;
  /** Repeating timer; opaque handle. */
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** One-shot timer; opaque handle. */
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Every ledger-*.json file currently in the shared state dir (main + subagents, any session). */
  loadLedgers(): Promise<SessionLedger[]>;
  /** Atomically persist one ledger file. */
  saveLedger(ledger: SessionLedger): Promise<void>;
  /** Subscribe to state-dir file changes. cb receives the changed file name or null. Returns unsubscribe. */
  watchLedgerDir(cb: (fileName: string | null) => void): () => void;
  /** Pricing cache; a missing/corrupt file yields an empty cache — never throws. */
  loadPricingCache(): Promise<PricingCache>;
  /** Atomically persist the pricing cache. */
  savePricingCache(cache: PricingCache): Promise<void>;
  /** Fetch + parse one official currency page (never throws). */
  fetchPricing(currency: Currency): Promise<{ ok: true; data: PricingData } | { ok: false; error: string }>;
  /** Balance fetch with the resolved key (never throws). */
  fetchBalance(key: string): Promise<FetchBalanceResult>;
  /** Resolve the DeepSeek provider key via OMP's modelRegistry; undefined = no auth. Takes the provider to look up. */
  resolveApiKey(provider: string): Promise<string | undefined>;
  /** Error sink (wiring routes to pi.logger; tests may collect). Optional. */
  reportError?(err: unknown): void;
}

export interface StatuslineModel {
  id: string;
  provider: string;
}

export interface StatuslineSession {
  sessionId: string; // may be "" when the runtime provides none
  cwd: string;
  model: StatuslineModel | null; // ctx.model at session_start
  /** Bound by wiring to `(t) => { if (ctx.hasUI) ctx.ui.setStatus("deepseek", t); }` — never throws. */
  setStatus(text: string | undefined): void;
}

export interface UsageMessageInput {
  /** Event instant, epoch ms. */
  ts: number;
  /** Model that produced the message (message.model + provider), or null. */
  model: StatuslineModel | null;
  /** The session model at the event (ctx.model), or null. */
  sessionModel: StatuslineModel | null;
  /** Message usage tokens (optional → 0). */
  cacheRead?: number;
  input?: number;
  output?: number;
}

export interface StatuslineController {
  /** session_start. */
  startSession(session: StatuslineSession): void;
  /** Push a config snapshot (wiring reads ds-statusline.yml async then calls this). */
  setConfig(config: Config): void;
  /** message_end — DeepSeek assistant usage accumulates + renders SYNCHRONOUSLY. */
  messageEnd(message: UsageMessageInput): void;
  /** session_shutdown — clear status, stop every timer/watch, drop state. */
  shutdown(): void;
  /**
   * User-initiated `/ds-statusline --force-refresh` / "refresh prices now".
   * Re-fetches and re-parses EVERY currency that has a cache entry (union of
   * the on-disk cache and this controller's in-memory cache); when nothing is
   * cached yet, fetches the current display currency. On full success the
   * cache is atomically overwritten, in-memory state updated, retry gates
   * cleared, and the status line re-rendered with the fresh prices. On ANY
   * fetch failure nothing is written and every old entry is kept. Never
   * throws. Returns the refreshed currencies or a joined error.
   */
  forceRefreshPrices(): Promise<ForceRefreshPricesResult>;
}

export type ForceRefreshPricesResult =
  | { ok: true; refreshed: Currency[] }
  | { ok: false; error: string };

export function createStatuslineController(env: StatuslineEnv): StatuslineController {
  let config: Config = { ...DEFAULT_CONFIG };
  let session: StatuslineSession | null = null;
  let destroyed = false;
  let mainLedger: SessionLedger | null = null;
  let subagentLedgers: SessionLedger[] = [];
  let lastModel: StatuslineModel | null = null;
  let observedDeepSeekProvider = "deepseek";
  let balanceRows: BalanceRow[] = [];
  let balanceUnauthorized = false;
  let pricingCache: PricingCache = { entries: {} };
  let pricingCacheLoaded = false; // true once the on-disk cache has been read (fetch-once-forever gate)
  const pricingInFlight = new Set<Currency>();
  const pricingRetryAt = new Map<Currency, number>();
  let tickerHandle: unknown = null;
  let scanHandle: unknown = null;
  let saveTimer: unknown = null;
  let balanceTimer: unknown = null;
  let balanceInFlight = false;
  let watcherUnsub: (() => void) | null = null;
  let lastRenderedText: string | null = null; // null = nothing currently shown

  function startSession(next: StatuslineSession): void {
    if (destroyed) return;
    if (session !== null) {
      // Fresh start on a live controller: tear the previous session down first.
      shutdown();
      destroyed = false; // shutdown() marks the controller terminal; a fresh start revives it
    }
    session = next;
    mainLedger = newLedger(next.sessionId, next.cwd, env.now());
    lastModel = next.model;
    if (next.model !== null && isDeepSeekModel(next.model) && next.model.provider !== "") {
      observedDeepSeekProvider = next.model.provider;
    }
    watcherUnsub = env.watchLedgerDir((fileName) => {
      if (destroyed || session === null) return;
      const own = session.sessionId === "" ? null : `ledger-${session.sessionId}.json`;
      if (fileName !== null && fileName === own) return;
      void refreshLedgersFromDisk();
    });
    scanHandle = env.setInterval(() => {
      void refreshLedgersFromDisk();
    }, LEDGER_SCAN_MS);
    tickerHandle = env.setInterval(() => {
      renderNow();
    }, TICK_MS);
    void env
      .loadPricingCache()
      .then((cache) => {
        if (destroyed || session === null) return;
        pricingCache = cache;
        pricingCacheLoaded = true;
        renderNow();
      })
      .catch((err) => env.reportError?.(err));
    void refreshLedgersFromDisk().catch((err) => env.reportError?.(err));
    renderNow();
  }

  function setConfig(configSnapshot: Config): void {
    config = configSnapshot;
    if (!destroyed && session !== null) renderNow();
  }

  function messageEnd(message: UsageMessageInput): void {
    if (destroyed || session === null || mainLedger === null) return;
    const ledger = mainLedger;
    const msgModel: StatuslineModel | null =
      message.model !== null && message.model.id !== "" ? message.model : null;
    // Per-request attribution: the model that actually produced this message
    // (message.model) is the ground truth for whether this is DeepSeek work —
    // fallback chains switch per request, so the session's static ctx.model
    // cannot reveal it. The session model (ctx.model) is therefore only a
    // fallback when the runtime carries no per-request model; it NEVER
    // overrides a present message model. A message produced by a
    // non-DeepSeek model (e.g. a Codex fallback under a DeepSeek-primary
    // chain) is not DeepSeek usage and must not be charged or shown as one.
    const attribution: StatuslineModel | null =
      msgModel !== null
        ? isDeepSeekModel(msgModel)
          ? msgModel
          : null
        : message.sessionModel !== null && isDeepSeekModel(message.sessionModel)
          ? message.sessionModel
          : null;
    if (attribution === null) {
      // Not DeepSeek work. Keep the ctx.model signal (sessionModel) as the
      // current/last session model so clause-(b) visibility — and its price
      // row when that model is DeepSeek — stays correct; it never creates
      // usage or charges the event's tokens.
      if (message.sessionModel !== null) lastModel = message.sessionModel;
      return;
    }
    lastModel = attribution;
    if (attribution.provider !== "") observedDeepSeekProvider = attribution.provider;
    const schedule = pricingCache.entries[currentCurrency()]?.data.schedule ?? null;
    addUsage(ledger, {
      modelId: attribution.id,
      ts: message.ts,
      cacheHit: message.cacheRead,
      cacheMiss: message.input,
      output: message.output,
      schedule,
    });
    if (saveTimer === null) saveTimer = env.setTimeout(flushLedgerSave, LEDGER_SAVE_DEBOUNCE_MS);
    renderNow();
    void refreshLedgersFromDisk().catch((err) => env.reportError?.(err));
  }

  function shutdown(): void {
    if (destroyed) return;
    destroyed = true;
    if (session !== null) session.setStatus(undefined);
    if (tickerHandle !== null) {
      env.clearInterval(tickerHandle);
      tickerHandle = null;
    }
    if (scanHandle !== null) {
      env.clearInterval(scanHandle);
      scanHandle = null;
    }
    if (saveTimer !== null) {
      env.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (balanceTimer !== null) {
      env.clearTimeout(balanceTimer);
      balanceTimer = null;
    }
    if (watcherUnsub !== null) {
      watcherUnsub();
      watcherUnsub = null;
    }
    session = null;
    mainLedger = null;
    subagentLedgers = [];
    balanceRows = [];
    lastRenderedText = null;
  }

  function flushLedgerSave(): void {
    saveTimer = null;
    if (destroyed || session === null || mainLedger === null) return;
    if (session.sessionId === "") return;
    const ledger = mainLedger;
    void env.saveLedger(ledger).catch((err) => env.reportError?.(err));
  }

  async function refreshLedgersFromDisk(): Promise<void> {
    if (destroyed || session === null) return;
    let all: SessionLedger[];
    try {
      all = await env.loadLedgers();
    } catch (err) {
      env.reportError?.(err);
      return;
    }
    if (destroyed || session === null) return;
    const s = session;
    subagentLedgers = all.filter((l) => l.sessionId !== s.sessionId);
    renderNow();
  }

  function currentCurrency(): Currency {
    return resolveDisplayCurrency(config.displayCurrency, balanceRows);
  }

  function aggregateNow(): SessionLedger | null {
    if (mainLedger === null) return null;
    return aggregateSessionTree(mainLedger, subagentLedgers, env.now());
  }

  /**
   * Model whose price row the status line shows: the last per-request DeepSeek
   * attribution (survives Codex stretches), else the model behind the most
   * recent usage-bearing ledger in the session tree — which covers a DeepSeek
   * subagent running under a Codex main, where this controller never sees a
   * DeepSeek `message_end`. Returns null when nothing DeepSeek is in use.
   */
  function derivedActiveModelId(): string | null {
    if (lastModel !== null && isDeepSeekModel(lastModel)) return lastModel.id;
    const candidates = mainLedger !== null ? [mainLedger, ...subagentLedgers] : subagentLedgers;
    let best: SessionLedger | null = null;
    for (const ledger of candidates) {
      if (ledger.buckets.length === 0) continue;
      if (best === null || ledger.lastTs > best.lastTs) best = ledger;
    }
    if (best === null) return null;
    if (best.buckets.length === 1) return best.buckets[0].modelId;
    let most: { modelId: string; tokens: number } | null = null;
    for (const b of best.buckets) {
      const tokens = b.cacheHit + b.cacheMiss + b.output;
      if (most === null || tokens > most.tokens) most = { modelId: b.modelId, tokens };
    }
    return most?.modelId ?? null;
  }

  function isVisibleNow(): boolean {
    if (!config.enabled || destroyed || session === null) return false;
    if (config.alwaysShow) return true;
    const tree = aggregateNow();
    const ledgers = tree !== null && tree.buckets.length > 0 ? [tree] : null;
    return deepseekActive({ nowMs: env.now(), model: lastModel, ledgers });
  }

  function balanceSegment(currency: Currency): BalanceRenderState {
    if (balanceUnauthorized) return { kind: "unauthorized" };
    const row = balanceRowFor(balanceRows, currency);
    return row === undefined ? null : { kind: "ok", currency: row.currency, total: row.totalBalance };
  }

  function renderNow(): void {
    if (destroyed || session === null) return;
    const s = session;
    if (!isVisibleNow()) {
      if (lastRenderedText !== null) {
        s.setStatus(undefined);
        lastRenderedText = null;
      }
      return;
    }
    const currency = currentCurrency();
    const pricing = pricingCache.entries[currency]?.data ?? null;
    const tree = aggregateNow();
    if (tree === null) return; // unreachable: a live session always has its main ledger
    const text = renderStatusText({
      nowMs: env.now(),
      timezone: config.timezone,
      pricing,
      activeModelId: derivedActiveModelId(),
      balance: balanceSegment(currency),
      sessionCost: pricing !== null ? estimateSessionCost(tree, pricing) : null,
    });
    if (text !== lastRenderedText) {
      s.setStatus(text);
      lastRenderedText = text;
    }
    maybeEnsurePricing(currency);
    maybeRefreshBalance();
  }

  function maybeEnsurePricing(currency: Currency): void {
    if (!pricingCacheLoaded) return; // wait for the on-disk cache read — cached entries of ANY age must be served with zero fetches
    if (pricingCache.entries[currency] !== undefined) return;
    if (pricingInFlight.has(currency)) return;
    const retryAt = pricingRetryAt.get(currency) ?? 0;
    if (env.now() < retryAt) return;
    pricingInFlight.add(currency);
    env
      .fetchPricing(currency)
      .then((res) => {
        if (res.ok) {
          pricingCache.entries[currency] = { fetchedAt: new Date(env.now()).toISOString(), data: res.data };
          pricingRetryAt.delete(currency);
          void env.savePricingCache(pricingCache).catch((err) => env.reportError?.(err));
        } else {
          pricingRetryAt.set(currency, env.now() + PRICING_RETRY_MS);
        }
      })
      .catch((err) => {
        env.reportError?.(err);
        pricingRetryAt.set(currency, env.now() + PRICING_RETRY_MS);
      })
      .finally(() => {
        pricingInFlight.delete(currency);
        renderNow();
      });
  }

  function maybeRefreshBalance(): void {
    if (!session || destroyed) return;
    if (balanceTimer !== null || balanceInFlight) return;
    balanceTimer = env.setTimeout(() => {
      balanceTimer = null;
      void runBalanceCycle();
    }, 0);
  }

  async function runBalanceCycle(): Promise<void> {
    if (destroyed || session === null) return;
    balanceInFlight = true;
    try {
      if (!isVisibleNow()) return;
      const provider = observedDeepSeekProvider;
      const key = await env.resolveApiKey(provider);
      if (destroyed || session === null) return;
      if (!isVisibleNow()) return;
      if (key === undefined || key === "") {
        // No auth configured: omit the segment entirely, never "bal ✕".
        balanceRows = [];
        balanceUnauthorized = false;
        renderNow();
        return;
      }
      const res = await env.fetchBalance(key);
      if (destroyed || session === null) return;
      if (!isVisibleNow()) return;
      if (res.ok) {
        balanceRows = res.rows;
        balanceUnauthorized = false;
      } else if (res.kind === "unauthorized") {
        balanceRows = [];
        balanceUnauthorized = true;
      }
      // http/network/parse failures keep the last rows silently.
      renderNow();
    } catch (err) {
      env.reportError?.(err);
    } finally {
      balanceInFlight = false;
      if (destroyed || session === null) return;
      if (isVisibleNow()) {
        const delayMs = balanceUnauthorized
          ? config.balanceRetrySec * 1000
          : config.balanceRefreshSec * 1000;
        balanceTimer = env.setTimeout(() => {
          balanceTimer = null;
          void runBalanceCycle();
        }, delayMs);
      }
    }
  }

  function currenciesOf(cache: PricingCache): Currency[] {
    return Object.keys(cache.entries) as Currency[];
  }

  async function forceRefreshPrices(): Promise<ForceRefreshPricesResult> {
    if (destroyed || session === null) return { ok: false, error: "no active session" };
    // Cache read is async at session_start; a command can land before it settles.
    if (!pricingCacheLoaded) {
      pricingCache = await env.loadPricingCache(); // env contract: never throws
      pricingCacheLoaded = true;
    }
    // "Every cached currency" = what is on disk right now (other sessions may
    // have fetched since we loaded) plus anything we hold that has not flushed.
    const onDisk = await env.loadPricingCache(); // env contract: never throws
    const targets = new Set<Currency>([...currenciesOf(onDisk), ...currenciesOf(pricingCache)]);
    const currencies = targets.size > 0 ? [...targets] : [currentCurrency()];

    const results = await Promise.all(
      currencies.map(async (currency) => ({ currency, result: await env.fetchPricing(currency) })),
    );
    const failed: { currency: Currency; error: string }[] = [];
    for (const r of results) {
      if (!r.result.ok) failed.push({ currency: r.currency, error: r.result.error });
    }
    if (failed.length > 0) {
      const now = env.now();
      for (const f of failed) {
        // No entry for the failed currency → arm the auto-retry ceiling so the
        // 1 s ticker does not hammer the page while the line is visible.
        if (pricingCache.entries[f.currency] === undefined) {
          pricingRetryAt.set(f.currency, now + PRICING_RETRY_MS);
        }
      }
      return { ok: false, error: failed.map((f) => `${f.currency}: ${f.error}`).join("; ") };
    }

    const fetchedAt = new Date(env.now()).toISOString();
    const entries: PricingCache["entries"] = {};
    for (const { currency, result } of results) {
      if (result.ok) entries[currency] = { fetchedAt, data: result.data };
    }
    const next: PricingCache = { entries };
    pricingCache = next;
    pricingCacheLoaded = true;
    for (const currency of currencies) pricingRetryAt.delete(currency);
    try {
      await env.savePricingCache(next);
    } catch (err) {
      env.reportError?.(err);
      renderNow(); // fresh data is already in memory; still surface it
      return { ok: false, error: "could not persist refreshed pricing cache" };
    }
    renderNow();
    return { ok: true, refreshed: currencies };
  }

  return { startSession, setConfig, messageEnd, shutdown, forceRefreshPrices };
}
