// lib/usage.ts — per-session DeepSeek usage ledgers: in-memory accumulation
// bucketed per model × pricing phase, atomic JSON persistence under
// <agentDir>/extensions/deepseek-statusline/, and the session-tree fold
// (main + eligible subagent ledgers) that the controller turns into the
// status-line cost figure.
//
// Bucket phase follows the pricing window: an event observed while the
// current schedule says "peak" lands in a peak bucket (full rate); an
// "off-peak" event lands in an offPeak bucket (discounted rate). Before any
// schedule is known (pricing not fetched yet) every event buckets as "peak"
// — full rate, never a guessed discount. Persisted ledger files are named
// ledger-<sessionId>.json and share their directory with pricing-cache.json,
// which cleanup must never touch.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { phaseAt, type Schedule } from "./window";

/** Phase a usage bucket is priced under: "peak" (full rate) or "offPeak" (half rate). */
export type BucketPhase = "peak" | "offPeak";

/**
 * One observed DeepSeek usage charge (an assistant `message_end` step
 * attributed to a DeepSeek model). `ts` is the event's epoch-ms instant,
 * which drives both the bucket phase and the ledger's advancing `lastTs`.
 *
 * The token fields are optional: a missing/undefined field counts as 0 (an
 * event may carry only a cache read, or only a cache miss + output, etc.).
 *
 * `schedule` is optional. When it is a non-null Schedule, the bucket phase is
 * resolved through the pricing window at `ts` (window "off-peak" maps to the
 * bucket phase "offPeak"); when it is absent or null no schedule is known yet
 * and the event buckets as "peak" — the full-rate bucket.
 */
export interface UsageEvent {
  modelId: string;
  /** Epoch ms of the underlying usage (the message_end instant). */
  ts: number;
  /** Cache-hit input tokens; absent/undefined counts as 0. */
  cacheHit?: number;
  /** Cache-miss input tokens; absent/undefined counts as 0. */
  cacheMiss?: number;
  /** Output tokens; absent/undefined counts as 0. */
  output?: number;
  /** Pricing-window schedule in effect at `ts`; absent/null → "peak" bucket. */
  schedule?: Schedule | null;
}

/**
 * Summed token counts for one (modelId, phase) pair. Numbers are exact sums of
 * the events folded in; tokens are never rounded or scaled here.
 */
export interface UsageBucket {
  modelId: string;
  phase: BucketPhase;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/**
 * One session's accumulated usage: the main session or a subagent session.
 * `startTs` is fixed at session start; `lastTs` is the newest event `ts` seen
 * (a fresh ledger starts with `lastTs === startTs`).
 */
export interface SessionLedger {
  sessionId: string;
  cwd: string;
  startTs: number;
  lastTs: number;
  buckets: UsageBucket[];
}

/**
 * Subagent sessions are folded into the main session tree when their `cwd`
 * matches the main session's and they started within this window before it:
 * `startTs >= main.startTs - SUBAGENT_WINDOW_MS` (inclusive).
 */
export const SUBAGENT_WINDOW_MS = 60_000;

/**
 * Ledger files older than this (30 days) are removed by cleanupOldLedgers.
 * Pricing-cache.json is never a ledger file and is never removed.
 */
export const DEFAULT_LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A token field counts as 0 unless it is a finite non-negative number. Runtime
 * events never carry negative tokens; ignoring anything else keeps bucket sums
 * (and the persisted ledger, which loadLedger re-validates) well-formed.
 */
function tokenOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Create an empty ledger for a session. `buckets` starts empty and
 * `lastTs === startTs` until the first usage event advances it.
 */
export function newLedger(sessionId: string, cwd: string, startTs: number): SessionLedger {
  return { sessionId, cwd, startTs, lastTs: startTs, buckets: [] };
}

/**
 * Fold one usage event into `ledger` in place: find (or create, appended in
 * first-seen order) the bucket for the event's (modelId, phase) pair and add
 * the event's tokens to it. The phase is `event.schedule`'s window phase at
 * `event.ts`, or "peak" when the event carries no schedule. `lastTs` advances
 * to the newest event `ts`. Returns the same ledger for chaining.
 */
export function addUsage(ledger: SessionLedger, event: UsageEvent): SessionLedger {
  // Window phases are "peak" | "off-peak"; bucket phases are "peak" | "offPeak".
  const phase: BucketPhase =
    event.schedule != null
      ? phaseAt(event.ts, event.schedule).phase === "peak"
        ? "peak"
        : "offPeak"
      : "peak";

  let bucket = ledger.buckets.find((b) => b.modelId === event.modelId && b.phase === phase);
  if (bucket === undefined) {
    bucket = { modelId: event.modelId, phase, cacheHit: 0, cacheMiss: 0, output: 0 };
    ledger.buckets.push(bucket);
  }
  bucket.cacheHit += tokenOf(event.cacheHit);
  bucket.cacheMiss += tokenOf(event.cacheMiss);
  bucket.output += tokenOf(event.output);

  if (event.ts > ledger.lastTs) ledger.lastTs = event.ts;
  return ledger;
}

/**
 * Directory ledger files live in under an agent dir, shared with
 * pricing-cache.json: <agentDir>/extensions/deepseek-statusline/.
 */
export function ledgerDir(agentDir: string): string {
  return join(agentDir, "extensions", "deepseek-statusline");
}

/** Ledger file path for a session: <ledgerDir(agentDir)>/ledger-<sessionId>.json */
export function ledgerPath(agentDir: string, sessionId: string): string {
  return join(ledgerDir(agentDir), `ledger-${sessionId}.json`);
}

/**
 * Persist a ledger atomically (temp file + rename), creating parent dirs as
 * needed. On any failure the previous file content is untouched and the temp
 * file is removed.
 */
export async function saveLedger(filePath: string, ledger: SessionLedger): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBucketPhase(value: unknown): value is BucketPhase {
  return value === "peak" || value === "offPeak";
}

function isUsageBucket(value: unknown): value is UsageBucket {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.modelId !== "string") return false;
  if (!isBucketPhase(b.phase)) return false;
  return (
    isFiniteNumber(b.cacheHit) && b.cacheHit >= 0 &&
    isFiniteNumber(b.cacheMiss) && b.cacheMiss >= 0 &&
    isFiniteNumber(b.output) && b.output >= 0
  );
}

function isSessionLedger(value: unknown): value is SessionLedger {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const l = value as Record<string, unknown>;
  if (typeof l.sessionId !== "string") return false;
  if (typeof l.cwd !== "string") return false;
  if (!isFiniteNumber(l.startTs) || !isFiniteNumber(l.lastTs)) return false;
  if (!Array.isArray(l.buckets)) return false;
  return l.buckets.every(isUsageBucket);
}

/**
 * Read and validate a ledger file. A missing file, unparseable JSON, or JSON
 * that is not a well-formed SessionLedger (wrong field types, a bad bucket
 * phase, negative token counts, …) yields null — never a throw. The returned
 * ledger is normalized to the contract fields only.
 */
export async function loadLedger(filePath: string): Promise<SessionLedger | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null; // missing / unreadable
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON
  }
  if (!isSessionLedger(parsed)) return null;
  return {
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    startTs: parsed.startTs,
    lastTs: parsed.lastTs,
    buckets: parsed.buckets.map((b) => ({
      modelId: b.modelId,
      phase: b.phase,
      cacheHit: b.cacheHit,
      cacheMiss: b.cacheMiss,
      output: b.output,
    })),
  };
}

const LEDGER_FILE_RE = /^ledger-.+\.json$/;

/**
 * Load every valid ledger-*.json file in `dir`, in filename order. Corrupt or
 * mis-shaped ledger files and every non-ledger file (pricing-cache.json,
 * other.json, notes.txt, stray .tmp files, …) are skipped. A missing or
 * unreadable dir yields [].
 */
export async function loadLedgersIn(dir: string): Promise<SessionLedger[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ledgers: SessionLedger[] = [];
  for (const name of names.sort()) {
    if (!LEDGER_FILE_RE.test(name)) continue;
    const ledger = await loadLedger(join(dir, name));
    if (ledger !== null) ledgers.push(ledger);
  }
  return ledgers;
}

/**
 * Remove ledger-*.json files in `dir` whose mtime is older than `maxAgeMs`
 * (default DEFAULT_LEDGER_MAX_AGE_MS = 30 days) relative to `nowMs` (default
 * Date.now()). Only ledger files are ever considered — pricing-cache.json and
 * other non-ledger files are never touched, however old. Returns the deleted
 * file paths in filename order.
 */
export async function cleanupOldLedgers(
  dir: string,
  opts?: { maxAgeMs?: number; nowMs?: number },
): Promise<string[]> {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_LEDGER_MAX_AGE_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of names.sort()) {
    if (!LEDGER_FILE_RE.test(name)) continue;
    const filePath = join(dir, name);
    try {
      const info = await stat(filePath);
      if (nowMs - info.mtimeMs > maxAgeMs) {
        await rm(filePath, { force: true });
        deleted.push(filePath);
      }
    } catch {
      // Vanished or unreadable between listing and stat/rm: not ours to force.
    }
  }
  return deleted;
}

function foldBucket(into: Map<string, UsageBucket>, bucket: UsageBucket): void {
  const key = `${bucket.modelId}\u0000${bucket.phase}`;
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, {
      modelId: bucket.modelId,
      phase: bucket.phase,
      cacheHit: bucket.cacheHit,
      cacheMiss: bucket.cacheMiss,
      output: bucket.output,
    });
  } else {
    existing.cacheHit += bucket.cacheHit;
    existing.cacheMiss += bucket.cacheMiss;
    existing.output += bucket.output;
  }
}

/**
 * Fold the main session ledger and its eligible subagent ledgers into one
 * aggregated ledger: same `cwd` as the main session AND
 * `startTs >= main.startTs - SUBAGENT_WINDOW_MS` (the 60 s window, inclusive)
 * AND `lastTs <= nowMs`. Foreign-cwd, too-old, or not-yet-closed (future
 * `lastTs`) subagents are excluded.
 *
 * The result carries the main session's sessionId/cwd/startTs, its buckets
 * summed by (modelId, phase) with the eligible subagents' buckets (first-seen
 * order), and `lastTs` = the newest lastTs among the main session and the
 * folded subagents. Inputs are never mutated; the returned ledger and its
 * buckets are fresh objects.
 */
export function aggregateSessionTree(
  main: SessionLedger,
  subagents: readonly SessionLedger[],
  nowMs: number = Date.now(),
): SessionLedger {
  const eligible = subagents.filter(
    (sub) =>
      sub.cwd === main.cwd &&
      sub.startTs >= main.startTs - SUBAGENT_WINDOW_MS &&
      sub.lastTs <= nowMs,
  );

  const merged = new Map<string, UsageBucket>();
  for (const bucket of main.buckets) foldBucket(merged, bucket);
  for (const sub of eligible) {
    for (const bucket of sub.buckets) foldBucket(merged, bucket);
  }

  let lastTs = main.lastTs;
  for (const sub of eligible) {
    if (sub.lastTs > lastTs) lastTs = sub.lastTs;
  }

  return {
    sessionId: main.sessionId,
    cwd: main.cwd,
    startTs: main.startTs,
    lastTs,
    buckets: [...merged.values()],
  };
}
