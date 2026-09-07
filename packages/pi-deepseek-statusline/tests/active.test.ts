// tests/active.test.ts — DeepSeek-in-use predicate (`isDeepSeekModel`) and the
// status-line visibility decision (`deepseekActive`): pure-Codex hidden,
// DeepSeek message_end → visible, DeepSeek subagent under a Codex main →
// visible, >60 s idle with no in-tree usage → hidden, `alwaysShow` pin, and
// the treeHasUsage keeps-visible clause. Every instant is a deterministic
// epoch-ms vector via Date.UTC; no I/O, no timers, no real ~/.omp.

import { describe, expect, it } from "vitest";
import { ACTIVE_WINDOW_MS, deepseekActive, isDeepSeekModel } from "../lib/active";
import type { ActiveLedger, ActiveUsageBucket } from "../lib/active";

// ─── shared fixtures ────────────────────────────────────────────────────────

/** Tue 2026-09-08 12:00:00Z — arbitrary deterministic "now". */
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const MINUTE = 60_000;
const CWD = "/repo";

const CODEX_MODEL = { id: "claude-sonnet-4-5", provider: "anthropic" };
const DEEPSEEK_MODEL = { id: "deepseek-v4-flash", provider: "deepseek" };

/** One real (non-zero) DeepSeek usage bucket — enough to mark a ledger used. */
function bucket(modelId: string): ActiveUsageBucket {
  return { modelId, phase: "peak", cacheHit: 0, cacheMiss: 1, output: 0 };
}

/** A session ledger that HAS recorded DeepSeek usage (buckets non-empty). */
function usedLedger(sessionId: string, lastTs: number, modelId = "deepseek-v4-flash"): ActiveLedger {
  return {
    sessionId,
    cwd: CWD,
    startTs: lastTs - 30 * MINUTE,
    lastTs,
    buckets: [bucket(modelId)],
  };
}

/** A fresh session ledger that has NOT recorded any usage yet. */
function freshLedger(sessionId: string, startTs: number): ActiveLedger {
  return { sessionId, cwd: CWD, startTs, lastTs: startTs, buckets: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// isDeepSeekModel
// ═══════════════════════════════════════════════════════════════════════════

describe("isDeepSeekModel", () => {
  it("returns false for undefined", () => {
    expect(isDeepSeekModel(undefined)).toBe(false);
  });

  it("matches deepseek-* model ids on any provider (Nan Builders, OpenRouter, custom proxies, unknown)", () => {
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "nan" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash", provider: "openrouter" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash-vision-exp", provider: "custom-proxy" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "unknown" })).toBe(true);
  });

  it("matches provider 'deepseek' (direct API) regardless of the id prefix", () => {
    expect(isDeepSeekModel({ id: "deepseek-chat", provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-reasoner", provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ id: "anything", provider: "deepseek" })).toBe(true);
  });

  it("prefix match is case-insensitive; provider match requires exactly 'deepseek'", () => {
    expect(isDeepSeekModel({ id: "DEEPSEEK-CHAT", provider: "custom" })).toBe(true);
    expect(isDeepSeekModel({ id: "DeepSeek-V4-Flash", provider: "custom-proxy" })).toBe(true);
    // A lookalike provider name must NOT match — equality, not a prefix.
    expect(isDeepSeekModel({ id: "claude-sonnet-4-5", provider: "deepseek-proxy" })).toBe(false);
    expect(isDeepSeekModel({ id: "claude-sonnet-4-5", provider: "DeepSeek" })).toBe(false);
  });

  it("does not match non-DeepSeek models on any provider", () => {
    expect(isDeepSeekModel({ id: "claude-sonnet-4-5", provider: "anthropic" })).toBe(false);
    expect(isDeepSeekModel({ id: "gpt-4o", provider: "openai" })).toBe(false);
    expect(isDeepSeekModel({ id: "mimo-v2.5", provider: "xiaomi" })).toBe(false);
    expect(isDeepSeekModel({ id: "qwen3.6", provider: "nan" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deepseekActive
// ═══════════════════════════════════════════════════════════════════════════

describe("deepseekActive", () => {
  it("hides a pure-Codex session (Codex model, no DeepSeek usage anywhere)", () => {
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [] })).toBe(false);
    // No model captured yet, or no ledgers at all — still hidden.
    expect(deepseekActive({ nowMs: NOW, ledgers: [] })).toBe(false);
    expect(deepseekActive({ nowMs: NOW, model: null, ledgers: [] })).toBe(false);
  });

  it("shows when the current/last main-session model is DeepSeek (b) — even before any usage is recorded", () => {
    expect(deepseekActive({ nowMs: NOW, model: DEEPSEEK_MODEL, ledgers: [] })).toBe(true);
    // Prefix match on a non-deepseek provider also counts (per-request attribution).
    expect(
      deepseekActive({ nowMs: NOW, model: { id: "deepseek-v4-pro", provider: "nan" }, ledgers: [] }),
    ).toBe(true);
  });

  it("shows after a DeepSeek message_end records usage in the main ledger of a Codex main (mid-session fallback)", () => {
    const main = usedLedger("main-sess", NOW - 2_000);
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [main] })).toBe(true);
  });

  it("shows while a DeepSeek subagent ledger is touched under a Codex main, inside the 60 s window (a)", () => {
    const main = freshLedger("main-sess", NOW - 5 * MINUTE); // Codex main: no DeepSeek usage
    const subagent = usedLedger("sub-sess", NOW - 5_000);
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [main, subagent] })).toBe(true);
    // Explicit window boundary: 60 s ago is still "active", one second past is not
    // (but see the keeps-visible test below for what happens past the window).
    expect(
      deepseekActive({
        nowMs: NOW,
        model: CODEX_MODEL,
        ledgers: [usedLedger("sub-sess", NOW - ACTIVE_WINDOW_MS)],
      }),
    ).toBe(true);
    expect(
      deepseekActive({
        nowMs: NOW,
        model: CODEX_MODEL,
        ledgers: [usedLedger("sub-sess", NOW - ACTIVE_WINDOW_MS - 1_000)],
      }),
    ).toBe(true); // kept visible by (c) — see next test
  });

  it("keeps the line visible through a Codex stretch longer than 60 s once the tree has usage (c, treeHasUsage keeps-visible)", () => {
    // Usage landed 10 minutes ago; main has been pure Codex since. The line
    // must NOT blink off at the (a) window edge — the session tree's usage is
    // a latch that holds until the caller clears the tree at session end.
    const main = usedLedger("main-sess", NOW - 10 * MINUTE);
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [main] })).toBe(true);
    // Same via a finished DeepSeek subagent that ran earlier this session.
    const subagent = usedLedger("sub-sess", NOW - 2 * 60 * MINUTE);
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [subagent] })).toBe(true);
  });

  it("does not treat a fresh usage-free ledger as activity (only recorded usage counts)", () => {
    // A just-spawned DeepSeek subagent before its first message_end carries no
    // buckets; its lastTs is only the session start. Not yet "in use".
    const subagent = freshLedger("sub-sess", NOW - 1_000);
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [subagent] })).toBe(false);
  });

  it("hides after >60 s idle when the tree has no usage (foreign ledgers are excluded by the caller)", () => {
    // Earlier session's DeepSeek subagent (different cwd, finished 90 s ago)
    // sitting on disk must not keep a fresh Codex session's line visible.
    // In-tree composition is the CALLER's job (usage.aggregateSessionTree
    // filters by cwd + start window — covered in tests/usage.test.ts); this
    // module sees only in-tree ledgers. A fresh in-tree main with no usage
    // yet, and an empty tree, both stay hidden.
    const main = freshLedger("main-sess", NOW - 5 * MINUTE); // Codex main: no DeepSeek usage recorded
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [main] })).toBe(false);
    // Bare form: no in-tree usage at all → hidden.
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [] })).toBe(false);
  });

  it("pins the line visible when alwaysShow is true, regardless of usage or model", () => {
    expect(deepseekActive({ nowMs: NOW, model: CODEX_MODEL, ledgers: [], alwaysShow: true })).toBe(true);
    expect(deepseekActive({ nowMs: NOW, alwaysShow: true })).toBe(true);
  });
});
