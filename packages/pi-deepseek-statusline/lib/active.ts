/**
 * DeepSeek-in-use predicate + status-line visibility rules.
 *
 * The status line renders whenever DeepSeek is actually in use. Model fields
 * are static per session but usage is per request — a mid-session fallback
 * block flips the per-request model, and DeepSeek subagents run under
 * non-DeepSeek mains — so visibility is driven by the session tree's usage
 * ledgers, not by the model field alone.
 *
 * `deepseekActive` is TRUE iff ANY of:
 *  (a) recent request activity — the newest `lastTs` among the tree's
 *      usage-bearing ledgers is within ACTIVE_WINDOW_MS (60 s) of `nowMs`;
 *  (b) the current/last main-session model is a DeepSeek model
 *      (`isDeepSeekModel`);
 *  (c) treeHasUsage — the session tree carries DeepSeek usage this session.
 *
 * Clause (c) is the keeps-visible clause. Ledgers are only ever written for
 * DeepSeek request activity, so once a fallback block or a DeepSeek subagent
 * has recorded usage into the current session's tree, the line stays visible
 * for the rest of the session instead of blinking off 60 s after the last
 * DeepSeek request: it survives short Codex stretches after a fallback block
 * and subagent tool-call gaps longer than the (a) window. The caller must
 * pass only the CURRENT session's in-tree ledgers (main + eligible
 * subagents) and clear them at session end; (c) therefore expires with the
 * session, and a stale or foreign DeepSeek ledger from an earlier session
 * never keeps the line up.
 *
 * The line hides only when none of (a)–(c) hold AND config `alwaysShow` is
 * false (default). `alwaysShow: true` pins the line visible regardless of
 * usage or model state.
 *
 * Pure and self-contained: no I/O, no module state, no imports from other
 * lib modules. `nowMs` is injected so every call is deterministic. The
 * ledger/bucket/model shapes below are structural subsets of lib/usage's
 * `SessionLedger`/`UsageBucket` and OMP's `ctx.model`, so real objects pass
 * in without conversion.
 */

/** Model shape as seen on `ctx.model` (structural subset — unused fields allowed). */
export interface DeepSeekModel {
  id: string;
  provider: string;
}

/** One usage bucket of a ledger (structural subset of lib/usage `UsageBucket`). */
export interface ActiveUsageBucket {
  modelId: string;
  /** `"peak"` | `"offPeak"` — not read by this module; kept for shape parity. */
  phase: string;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/** One session ledger (structural subset of lib/usage `SessionLedger`). */
export interface ActiveLedger {
  sessionId: string;
  cwd: string;
  startTs: number;
  lastTs: number;
  buckets: readonly ActiveUsageBucket[];
}

/** Inputs to `deepseekActive`. */
export interface DeepSeekActiveInput {
  /** Epoch ms of "now" — injected for determinism (pure function). */
  nowMs: number;
  /** Current/last main-session `ctx.model`; clause (b). */
  model?: DeepSeekModel | null;
  /**
   * The current session tree's ledgers (main + eligible subagents), empty or
   * omitted when the tree has none. Only usage-bearing ledgers matter; a
   * fresh ledger with no buckets yet is not activity. Clauses (a) + (c).
   */
  ledgers?: readonly ActiveLedger[] | null;
  /** Config `alwaysShow` — when true, pins the line visible. Default false. */
  alwaysShow?: boolean;
}

/**
 * Recency window of clause (a): DeepSeek request activity counts as "in use"
 * while the newest usage `lastTs` is at most this far behind `nowMs`.
 */
export const ACTIVE_WINDOW_MS = 60_000;

/**
 * Check whether a model looks like a DeepSeek variant: model id prefixed
 * `deepseek-` (case-insensitive) on ANY provider, or provider exactly
 * `"deepseek"` (the direct DeepSeek API). Semantics copied from
 * `packages/pi-deepseek-cache/lib/helpers.ts`.
 */
export function isDeepSeekModel(model: DeepSeekModel | undefined): boolean {
  if (!model) return false;
  // Match by model ID prefix — the most reliable, provider-agnostic signal.
  // Works for NaN Builders, OpenRouter, direct DeepSeek API, and custom providers.
  if (model.id.toLowerCase().startsWith("deepseek-")) return true;
  // Match by provider name — direct DeepSeek API, covers edge cases where
  // model IDs don't use the deepseek- prefix.
  if (model.provider === "deepseek") return true;
  return false;
}

/**
 * DeepSeek-in-use / line-visibility decision (semantics in the file header).
 *
 * Returns true when the status line should render: `alwaysShow` pins it, a
 * DeepSeek model is current/last on the main session (b), the tree's newest
 * usage is within ACTIVE_WINDOW_MS (a), or the session tree has recorded
 * DeepSeek usage at all (c, the keeps-visible latch). Hidden otherwise.
 */
export function deepseekActive(input: DeepSeekActiveInput): boolean {
  const { nowMs, model, ledgers, alwaysShow = false } = input;

  if (alwaysShow) return true; // pinned visible — never hidden by the clauses below.

  // (b) current/last main-session model is DeepSeek.
  if (isDeepSeekModel(model ?? undefined)) return true;

  // Evidence for (a)/(c): ledgers that carry at least one usage bucket.
  // `lastTs` on a bucket-less ledger is just the session start and is NOT
  // request activity — only recorded usage counts.
  let newestUsageTs = -Infinity;
  let treeHasUsage = false;
  if (ledgers) {
    for (const ledger of ledgers) {
      if (ledger.buckets.length === 0) continue;
      treeHasUsage = true;
      if (ledger.lastTs > newestUsageTs) newestUsageTs = ledger.lastTs;
    }
  }

  // (a) DeepSeek request activity within the 60 s window.
  if (newestUsageTs !== -Infinity && nowMs - newestUsageTs <= ACTIVE_WINDOW_MS) return true;

  // (c) keeps-visible clause: the session tree has DeepSeek usage this
  // session, so stay visible (the caller clears the tree at session end).
  if (treeHasUsage) return true;

  return false;
}
