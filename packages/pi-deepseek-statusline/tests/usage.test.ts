// tests/usage.test.ts — usage ledgers: bucketing (model × phase sums), atomic
// JSON persistence in os.tmpdir() dirs, ledger-dir scanning + cleanup, and the
// session-tree fold (main + eligible subagents). All instants are deterministic
// epoch-ms vectors via Date.UTC(...); every token expectation is an exact sum.
// FS tests never touch the real ~/.omp — only mkdtempSync dirs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Schedule } from "../lib/window";
import {
  SUBAGENT_WINDOW_MS,
  addUsage,
  aggregateSessionTree,
  cleanupOldLedgers,
  ledgerDir,
  ledgerPath,
  loadLedger,
  loadLedgersIn,
  newLedger,
  saveLedger,
  type BucketPhase,
  type SessionLedger,
  type UsageBucket,
} from "../lib/usage";

// ─── shared fixtures ────────────────────────────────────────────────────────

/**
 * Canonical Mon–Fri UTC schedule (the window the official DeepSeek pricing
 * pages describe): 01:00–04:00 and 06:00–10:00, both half-open [start, end).
 */
const CANONICAL_SCHEDULE: Schedule = {
  spans: [
    { weekdays: [1, 2, 3, 4, 5], startMin: 60, endMin: 240 }, // 01:00–04:00
    { weekdays: [1, 2, 3, 4, 5], startMin: 360, endMin: 600 }, // 06:00–10:00
  ],
};

// Tue 2026-09-08 (verified: 2026-09-08 is a Tuesday) — events straddling the
// 04:00 UTC span-end boundary: 03:59:30Z is inside the peak span, 04:00:30Z is
// after it (off-peak).
const TUE_PEAK = Date.UTC(2026, 8, 8, 3, 59, 30);
const TUE_OFFPEAK = Date.UTC(2026, 8, 8, 4, 0, 30);

function bucket(
  modelId: string,
  phase: BucketPhase,
  cacheHit: number,
  cacheMiss: number,
  output: number,
): UsageBucket {
  return { modelId, phase, cacheHit, cacheMiss, output };
}

function ledgerOf(
  sessionId: string,
  cwd: string,
  startTs: number,
  lastTs: number,
  buckets: UsageBucket[],
): SessionLedger {
  return { sessionId, cwd, startTs, lastTs, buckets: buckets.map((b) => ({ ...b })) };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ds-statusline-usage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── file layout ────────────────────────────────────────────────────────────

describe("ledger file layout", () => {
  it("ledgerDir nests under agentDir/extensions/deepseek-statusline", () => {
    expect(ledgerDir("/home/u/.omp/agent")).toBe(
      join("/home/u/.omp/agent", "extensions", "deepseek-statusline"),
    );
  });

  it("ledgerPath appends ledger-<sessionId>.json inside ledgerDir", () => {
    const agentDir = "/home/u/.omp/agent";
    expect(ledgerPath(agentDir, "sess-42")).toBe(
      join(agentDir, "extensions", "deepseek-statusline", "ledger-sess-42.json"),
    );
  });
});

// ─── addUsage: bucketing ────────────────────────────────────────────────────

describe("addUsage", () => {
  it("creates one bucket per fresh (modelId, phase) pair and sums repeated events of the same pair into that one bucket (missing token fields count as 0)", () => {
    const ledger = newLedger("main-sess", "/repo", TUE_PEAK - 60_000);
    // No schedule on any event → every event buckets as "peak" (same pair).
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_PEAK, cacheHit: 120 });
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_PEAK + 1_000, cacheMiss: 30, output: 5 });
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_PEAK + 2_000, output: 10 });
    // A fresh (modelId, phase) pair starts its own bucket.
    addUsage(ledger, { modelId: "deepseek-v4-pro", ts: TUE_PEAK + 3_000, cacheMiss: 9 });

    expect(ledger.buckets).toEqual([
      bucket("deepseek-v4-flash", "peak", 120, 30, 15),
      bucket("deepseek-v4-pro", "peak", 0, 9, 0),
    ]);
  });

  it("buckets events straddling the 04:00Z boundary on Tue 2026-09-08 into different phases (peak vs offPeak) under the canonical schedule", () => {
    const ledger = newLedger("main-sess", "/repo", TUE_PEAK - 60_000);
    addUsage(ledger, {
      modelId: "deepseek-v4-flash",
      ts: TUE_PEAK, // 03:59:30Z ∈ [01:00, 04:00) → peak
      cacheMiss: 100,
      schedule: CANONICAL_SCHEDULE,
    });
    addUsage(ledger, {
      modelId: "deepseek-v4-flash",
      ts: TUE_OFFPEAK, // 04:00:30Z ∉ any span → off-peak
      cacheMiss: 50,
      output: 20,
      schedule: CANONICAL_SCHEDULE,
    });

    expect(ledger.buckets).toEqual([
      bucket("deepseek-v4-flash", "peak", 0, 100, 0),
      bucket("deepseek-v4-flash", "offPeak", 0, 50, 20),
    ]);
  });

  it("keeps distinct modelIds in separate buckets even within the same phase", () => {
    const ledger = newLedger("main-sess", "/repo", TUE_OFFPEAK - 60_000);
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_OFFPEAK, cacheMiss: 100, schedule: CANONICAL_SCHEDULE });
    addUsage(ledger, { modelId: "deepseek-v4-pro", ts: TUE_OFFPEAK, cacheMiss: 10, schedule: CANONICAL_SCHEDULE });

    expect(ledger.buckets).toEqual([
      bucket("deepseek-v4-flash", "offPeak", 0, 100, 0),
      bucket("deepseek-v4-pro", "offPeak", 0, 10, 0),
    ]);
  });

  it("buckets every event as phase 'peak' when the schedule is missing or null (full-rate bucket)", () => {
    const ledger = newLedger("main-sess", "/repo", TUE_PEAK);
    // Both instants would be off-peak under the canonical schedule — without a
    // schedule they must still land in the full-rate "peak" bucket.
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_OFFPEAK, cacheMiss: 40 });
    addUsage(ledger, { modelId: "deepseek-v4-pro", ts: TUE_OFFPEAK, cacheHit: 60, schedule: null });

    expect(ledger.buckets).toEqual([
      bucket("deepseek-v4-flash", "peak", 0, 40, 0),
      bucket("deepseek-v4-pro", "peak", 60, 0, 0),
    ]);
  });

  it("starts a fresh ledger with lastTs = startTs and advances lastTs to the max event ts seen", () => {
    const start = Date.UTC(2026, 8, 8, 3, 0, 0);
    const ledger = newLedger("main-sess", "/repo", start);
    expect(ledger.lastTs).toBe(start);

    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: start + 5_000, cacheMiss: 1 });
    expect(ledger.lastTs).toBe(start + 5_000);
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: start + 9_000, cacheMiss: 2 });
    addUsage(ledger, { modelId: "deepseek-v4-pro", ts: start + 2_000, cacheMiss: 3 }); // older → no move
    expect(ledger.lastTs).toBe(start + 9_000);
  });
});

// ─── persistence ────────────────────────────────────────────────────────────

describe("saveLedger / loadLedger", () => {
  it("round-trips a ledger deep-equal, auto-creates nested dirs, and leaves no .tmp litter", async () => {
    const agentDir = join(dir, "nested", "agent");
    const ledger = newLedger("main-sess", "/repo", TUE_PEAK - 60_000);
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_PEAK, cacheHit: 120, schedule: CANONICAL_SCHEDULE });
    addUsage(ledger, { modelId: "deepseek-v4-flash", ts: TUE_OFFPEAK, cacheMiss: 30, output: 5, schedule: CANONICAL_SCHEDULE });

    const file = ledgerPath(agentDir, "main-sess");
    await saveLedger(file, ledger);

    expect(existsSync(file)).toBe(true); // nested dirs created
    expect(await loadLedger(file)).toEqual(ledger); // deep toEqual round-trip
    expect(await loadLedger(file)).not.toBe(ledger); // freshly parsed object
    expect(readdirSync(ledgerDir(agentDir))).toEqual(["ledger-main-sess.json"]);
    expect(readdirSync(ledgerDir(agentDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("returns null for a missing file, corrupt JSON, and well-formed-but-wrong-shape JSON", async () => {
    await expect(loadLedger(join(dir, "absent.json"))).resolves.toBeNull();

    writeFileSync(join(dir, "corrupt.json"), "{ definitely not json");
    await expect(loadLedger(join(dir, "corrupt.json"))).resolves.toBeNull();

    // Control: the same body without the defect loads fine.
    const good = JSON.stringify(
      ledgerOf("s", "/w", 100, 100, [bucket("deepseek-v4-flash", "peak", 1, 2, 3)]),
    );
    const goodFile = join(dir, "good.json");
    writeFileSync(goodFile, good);
    await expect(loadLedger(goodFile)).resolves.toEqual(
      ledgerOf("s", "/w", 100, 100, [bucket("deepseek-v4-flash", "peak", 1, 2, 3)]),
    );

    const cases: Array<[string, string]> = [
      // Wrong field types.
      ["sessionId number", JSON.stringify({ sessionId: 7, cwd: "/w", startTs: 1, lastTs: 1, buckets: [] })],
      ["startTs string", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: "now", lastTs: 1, buckets: [] })],
      ["lastTs missing", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, buckets: [] })],
      ["buckets not array", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: {} })],
      ["bucket not object", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: ["peak"] })],
      ["bucket token string", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: [{ modelId: "m", phase: "peak", cacheHit: "120", cacheMiss: 0, output: 0 }] })],
      ["bucket token missing", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: [{ modelId: "m", phase: "peak", cacheHit: 1, cacheMiss: 2 }] })],
      // Bad phase string.
      ["bad phase string", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: [{ modelId: "m", phase: "off-peak", cacheHit: 1, cacheMiss: 2, output: 3 }] })],
      // Negative tokens.
      ["negative output", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: [{ modelId: "m", phase: "offPeak", cacheHit: 1, cacheMiss: 2, output: -3 }] })],
      ["negative cacheMiss", JSON.stringify({ sessionId: "s", cwd: "/w", startTs: 1, lastTs: 1, buckets: [{ modelId: "m", phase: "peak", cacheHit: 0, cacheMiss: -1, output: 0 }] })],
    ];
    let i = 0;
    for (const [label, body] of cases) {
      const file = join(dir, `bad-${i}.json`);
      i += 1;
      writeFileSync(file, body);
      await expect(loadLedger(file), label).resolves.toBeNull();
    }
  });

  it("loadLedgersIn returns only valid ledger-*.json files, skipping corrupt ledgers, pricing-cache.json, and other files", async () => {
    const goodA = ledgerOf("sess-a", "/repo", 1_000, 2_000, [bucket("deepseek-v4-flash", "peak", 100, 0, 0)]);
    const goodB = ledgerOf("sess-b", "/repo", 1_000, 2_000, [bucket("deepseek-v4-pro", "offPeak", 0, 0, 50)]);
    writeFileSync(join(dir, "ledger-sess-a.json"), JSON.stringify(goodA));
    writeFileSync(join(dir, "ledger-sess-b.json"), JSON.stringify(goodB));
    writeFileSync(join(dir, "ledger-corrupt.json"), "{ broken");
    // A valid-ledger-shaped body under a non-ledger name must NOT be loaded.
    writeFileSync(join(dir, "other.json"), JSON.stringify(goodA));
    writeFileSync(join(dir, "pricing-cache.json"), JSON.stringify({ entries: {} }));
    writeFileSync(join(dir, "notes.txt"), "not json at all");

    await expect(loadLedgersIn(dir)).resolves.toEqual([goodA, goodB]);
  });
});

// ─── cleanup ────────────────────────────────────────────────────────────────

describe("cleanupOldLedgers", () => {
  it("default 30-day max age: removes a 40-day-old ledger, keeps a fresh one, and returns the deleted paths", async () => {
    const oldFile = join(dir, "ledger-old.json");
    const freshFile = join(dir, "ledger-fresh.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(freshFile, "{}");
    const realNow = Date.now();
    const days = 86_400_000;
    // mtimes relative to the real clock — outcome is age-deterministic: the old
    // file is 40 days past (>> DEFAULT_LEDGER_MAX_AGE_MS), the fresh one is 0.
    utimesSync(oldFile, (realNow - 40 * days) / 1000, (realNow - 40 * days) / 1000);
    utimesSync(freshFile, realNow / 1000, realNow / 1000);

    await expect(cleanupOldLedgers(dir)).resolves.toEqual([oldFile]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("explicit {maxAgeMs, nowMs}: removes only ledger files older than the cutoff; pricing-cache.json stays byte-identical even when old; other files untouched", async () => {
    const nowMs = 1_000_000_000_000;
    const maxAgeMs = 10_000;

    const staleLedger = join(dir, "ledger-stale.json");
    const freshLedger = join(dir, "ledger-fresh.json");
    const pricing = join(dir, "pricing-cache.json");
    const notes = join(dir, "notes.txt");
    const other = join(dir, "other.json");
    writeFileSync(staleLedger, JSON.stringify(ledgerOf("stale", "/repo", 1, 1, [])));
    writeFileSync(freshLedger, JSON.stringify(ledgerOf("fresh", "/repo", 1, 1, [])));
    const pricingBody = JSON.stringify({ entries: { USD: { fetchedAt: "2000-01-01T00:00:00.000Z" } } });
    writeFileSync(pricing, pricingBody);
    writeFileSync(notes, "keep me");
    writeFileSync(other, "{}");
    // Everything except freshLedger is older than the cutoff (nowMs − 10 000).
    const staleAge = nowMs - 20_000;
    const freshAge = nowMs - 5_000;
    const ancientAge = nowMs - 100_000;
    utimesSync(staleLedger, staleAge / 1000, staleAge / 1000);
    utimesSync(freshLedger, freshAge / 1000, freshAge / 1000);
    utimesSync(pricing, ancientAge / 1000, ancientAge / 1000);
    utimesSync(notes, ancientAge / 1000, ancientAge / 1000);
    utimesSync(other, ancientAge / 1000, ancientAge / 1000);

    await expect(cleanupOldLedgers(dir, { maxAgeMs, nowMs })).resolves.toEqual([staleLedger]);
    expect(existsSync(staleLedger)).toBe(false);
    expect(existsSync(freshLedger)).toBe(true); // 5 s old < 10 s max age
    expect(readFileSync(pricing, "utf8")).toBe(pricingBody); // byte content unchanged
    expect(existsSync(pricing)).toBe(true);
    expect(readFileSync(notes, "utf8")).toBe("keep me");
    expect(existsSync(other)).toBe(true);
  });
});

// ─── session-tree aggregation ───────────────────────────────────────────────

describe("aggregateSessionTree", () => {
  const T0 = Date.UTC(2026, 8, 8, 8, 0, 0); // Tue 2026-09-08 08:00:00Z
  const NOW = T0 + 300_000;

  const main = ledgerOf("main-sess", "/repo", T0, T0 + 100_000, [
    bucket("deepseek-v4-flash", "peak", 100, 200, 300),
    bucket("deepseek-v4-pro", "peak", 1, 0, 0),
  ]);
  // startTs exactly main.startTs − SUBAGENT_WINDOW_MS → the inclusive boundary.
  const eligible = ledgerOf("sub-e", "/repo", T0 - SUBAGENT_WINDOW_MS, T0 + 150_000, [
    bucket("deepseek-v4-flash", "offPeak", 0, 40, 10),
    bucket("deepseek-v4-pro", "peak", 5, 0, 7),
  ]);
  const eligibleLow = ledgerOf("sub-low", "/repo", T0 - 10_000, T0 + 50_000, [
    bucket("deepseek-v4-pro", "offPeak", 2, 0, 0),
  ]);
  const foreignCwd = ledgerOf("sub-x", "/elsewhere", T0, T0 + 50_000, [
    bucket("deepseek-v4-flash", "peak", 9, 9, 9),
  ]);
  const tooOld = ledgerOf("sub-o", "/repo", T0 - SUBAGENT_WINDOW_MS - 1, T0 + 50_000, [
    bucket("deepseek-v4-flash", "peak", 8, 8, 8),
  ]);
  const future = ledgerOf("sub-f", "/repo", T0, T0 + 400_000, [
    bucket("deepseek-v4-flash", "peak", 7, 7, 7),
  ]);

  it("folds eligible subagents (same cwd, startTs ≥ main.startTs − 60 000, lastTs ≤ now) into main totals by (modelId, phase)", () => {
    const result = aggregateSessionTree(main, [eligible, eligibleLow], NOW);

    expect(result).toEqual(
      ledgerOf("main-sess", "/repo", T0, T0 + 150_000, [
        bucket("deepseek-v4-flash", "peak", 100, 200, 300),
        bucket("deepseek-v4-pro", "peak", 6, 0, 7), // main 1 + eligible 5 folded together
        bucket("deepseek-v4-flash", "offPeak", 0, 40, 10),
        bucket("deepseek-v4-pro", "offPeak", 2, 0, 0),
      ]),
    );
  });

  it("excludes foreign-cwd, too-old-startTs, and future-lastTs subagent ledgers", () => {
    const result = aggregateSessionTree(main, [foreignCwd, tooOld, future], NOW);

    // Only main folds → result equals main (lastTs = main.lastTs, same buckets).
    expect(result).toEqual(main);
    // …but is a fresh object, not main aliased.
    expect(result).not.toBe(main);
    expect(result.buckets[0]).not.toBe(main.buckets[0]);
  });

  it("carries main's sessionId/cwd/startTs and lastTs = the max folded lastTs", () => {
    const result = aggregateSessionTree(main, [eligible, eligibleLow], NOW);
    expect(result.sessionId).toBe("main-sess");
    expect(result.cwd).toBe("/repo");
    expect(result.startTs).toBe(T0);
    // eligibleLow (T0+50 000) and main (T0+100 000) are below eligible (T0+150 000).
    expect(result.lastTs).toBe(T0 + 150_000);
  });

  it("updates totals when a late-arriving subagent ledger is passed again with extra buckets and a later lastTs", () => {
    const lateSub = ledgerOf("sub-late", "/repo", T0 - SUBAGENT_WINDOW_MS, T0 + 120_000, [
      bucket("deepseek-v4-flash", "peak", 10, 0, 0),
    ]);
    const first = aggregateSessionTree(main, [lateSub], NOW);
    expect(first).toEqual(
      ledgerOf("main-sess", "/repo", T0, T0 + 120_000, [
        bucket("deepseek-v4-flash", "peak", 110, 200, 300),
        bucket("deepseek-v4-pro", "peak", 1, 0, 0),
      ]),
    );

    const lateSubUpdated = ledgerOf(
      "sub-late",
      "/repo",
      T0 - SUBAGENT_WINDOW_MS,
      T0 + 250_000, // still ≤ NOW → still eligible
      [
        ...lateSub.buckets,
        bucket("deepseek-v4-pro", "offPeak", 3, 4, 5),
      ],
    );
    const second = aggregateSessionTree(main, [lateSubUpdated], NOW);
    expect(second).toEqual(
      ledgerOf("main-sess", "/repo", T0, T0 + 250_000, [
        bucket("deepseek-v4-flash", "peak", 110, 200, 300),
        bucket("deepseek-v4-pro", "peak", 1, 0, 0),
        bucket("deepseek-v4-pro", "offPeak", 3, 4, 5),
      ]),
    );
  });

  it("does not mutate its inputs", () => {
    // Deep-freeze main + subagent ledgers (any in-place mutation would throw)
    // and snapshot their serialized form for a belt-and-braces equality check.
    const frozen = [main, eligible, foreignCwd].map((l) => deepFreeze(l));
    const [frozenMain, ...frozenSubs] = frozen;
    const before = JSON.stringify([frozenMain, ...frozenSubs]);

    const result = aggregateSessionTree(frozenMain, frozenSubs, NOW);

    expect(JSON.stringify([frozenMain, ...frozenSubs])).toBe(before);
    expect(result).toEqual(
      ledgerOf("main-sess", "/repo", T0, T0 + 150_000, [
        bucket("deepseek-v4-flash", "peak", 100, 200, 300),
        bucket("deepseek-v4-pro", "peak", 6, 0, 7),
        bucket("deepseek-v4-flash", "offPeak", 0, 40, 10),
      ]),
    );
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
