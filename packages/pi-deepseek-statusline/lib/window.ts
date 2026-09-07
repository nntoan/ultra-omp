/**
 * Pure peak/off-peak pricing-window engine over a recurring UTC weekday
 * schedule, plus countdown and local-clock rendering helpers.
 *
 * All window math in `phaseAt` runs on UTC instants (epoch ms) only — no
 * timezone arithmetic. Wall-clock rendering is isolated in `localClock`,
 * which delegates to `Intl` with an IANA zone. Zero runtime dependencies.
 */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type Phase = "peak" | "off-peak";

export interface ScheduleSpan {
  /** ISO weekdays the span applies to: 1=Monday … 7=Sunday (canonical: [1..5]). */
  weekdays: number[];
  /** Span start, minutes since UTC midnight — inclusive. */
  startMin: number;
  /** Span end, minutes since UTC midnight — exclusive; must be > startMin. */
  endMin: number;
}

export interface Schedule {
  spans: ScheduleSpan[];
}

/** ISO weekday (1=Mon … 7=Sun) of a UTC instant. */
function isoWeekday(utcMs: number): number {
  // Date#getUTCDay: 0=Sun … 6=Sat → shift to ISO 1=Mon … 7=Sun.
  return ((new Date(utcMs).getUTCDay() + 6) % 7) + 1;
}

/**
 * Peak/off-peak phase at a UTC instant, plus the next boundary and countdown.
 *
 * Peak iff the instant's UTC weekday is listed by a span AND its minutes
 * since UTC midnight lie in [startMin, endMin). Weekends (6, 7) never peak on
 * the canonical Mon–Fri schedule. The next boundary is the earliest span end
 * while peak, and the earliest future span start while off-peak — including
 * weekday wrap: Fri after 10:00 → Mon 01:00, Sat/Sun → Mon 01:00. A schedule
 * with no applicable span in the 8-day look-ahead (e.g. no spans at all)
 * yields `nextSwitchAtMs = Infinity` ("never"), so the invariant
 * `nextSwitchAtMs > nowMs` always holds.
 */
export function phaseAt(
  nowMs: number,
  s: Schedule,
): { phase: Phase; nextSwitchAtMs: number; countdownMs: number } {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todayDow = isoWeekday(dayStart);
  const msOfDay = nowMs - dayStart;

  let peak = false;
  for (const span of s.spans) {
    if (!span.weekdays.includes(todayDow)) continue;
    const startMs = span.startMin * MIN_MS;
    const endMs = span.endMin * MIN_MS;
    if (msOfDay >= startMs && msOfDay < endMs) {
      peak = true;
      break;
    }
  }

  // Scan at most the next 8 UTC days: any weekly-recurring boundary lies
  // within that window (worst case: the span's weekday is 7 days out).
  let nextSwitchAtMs = Number.POSITIVE_INFINITY;
  for (let d = 0; d <= 7; d += 1) {
    const dayMs = dayStart + d * DAY_MS;
    const dow = isoWeekday(dayMs);
    for (const span of s.spans) {
      if (!span.weekdays.includes(dow)) continue;
      if (peak) {
        const endMs = dayMs + span.endMin * MIN_MS;
        if (endMs > nowMs && endMs < nextSwitchAtMs) nextSwitchAtMs = endMs;
      } else {
        const startMs = dayMs + span.startMin * MIN_MS;
        if (startMs > nowMs && startMs < nextSwitchAtMs) nextSwitchAtMs = startMs;
      }
    }
  }

  return {
    phase: peak ? "peak" : "off-peak",
    nextSwitchAtMs,
    countdownMs: nextSwitchAtMs - nowMs,
  };
}

/**
 * "HH:MM" wall-clock rendering of a UTC instant in an IANA timezone
 * (DST-correct). `tz` may be omitted or "" → the system default zone.
 */
export function localClock(instantMs: number, tz?: string): string {
  const zone = tz ? tz : new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    // h23 keeps midnight as "00" (h24 can render "24").
    hourCycle: "h23",
  }).formatToParts(instantMs);
  let hour = "00";
  let minute = "00";
  for (const p of parts) {
    if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
  }
  return `${hour}:${minute}`;
}

/**
 * Compact countdown: "Xh Ym" from one hour up (whole minutes, seconds
 * dropped); "Ym Zs" below one hour. Examples: 18_720_000 → "5h 12m",
 * 90_000 → "1m 30s", 60_000 → "1m 0s".
 */
export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (ms >= HOUR_MS) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function parseHHMM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`scheduleFromSpans: expected "HH:MM", got ${JSON.stringify(value)}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`scheduleFromSpans: time out of range: ${JSON.stringify(value)}`);
  }
  return hours * 60 + minutes;
}

/**
 * Build a Schedule from the textual "HH:MM" UTC form the pricing parser
 * produces — e.g. the canonical Mon–Fri 01:00–04:00 + 06:00–10:00 pair →
 * startMin/endMin [60, 240] and [360, 600]. Input spans are copied, never
 * aliased.
 */
export function scheduleFromSpans(
  spans: Array<{ weekdays: number[]; start: string; end: string }>,
): Schedule {
  return {
    spans: spans.map((span) => ({
      weekdays: [...span.weekdays],
      startMin: parseHHMM(span.start),
      endMin: parseHHMM(span.end),
    })),
  };
}
