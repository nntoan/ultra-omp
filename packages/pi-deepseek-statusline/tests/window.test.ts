import { describe, expect, it } from "vitest";
import { formatCountdown, localClock, phaseAt, scheduleFromSpans } from "../lib/window";
import type { Schedule } from "../lib/window";

/**
 * Canonical Mon–Fri UTC schedule (the window the official DeepSeek pricing
 * pages describe): 01:00–04:00 and 06:00–10:00, both half-open [start, end).
 * Hand-built literal so the phase engine is tested independently of
 * scheduleFromSpans (which is itself asserted below).
 */
const canonical: Schedule = {
  spans: [
    { weekdays: [1, 2, 3, 4, 5], startMin: 60, endMin: 240 },
    { weekdays: [1, 2, 3, 4, 5], startMin: 360, endMin: 600 },
  ],
};

/**
 * Fixed UTC instants in the week of Monday 2026-03-02 — every weekday below
 * was verified against an independent oracle (python3 zoneinfo): 03-02 Mon,
 * 03-03 Tue, 03-04 Wed, 03-06 Fri, 03-07 Sat, 03-08 Sun, 03-09 Mon. Instants
 * are built with Date.UTC(...) only — never new Date("…") string parsing.
 * `day` is the day offset from Mon 2026-03-02.
 */
const at = (day: number, h: number, m = 0, s = 0): number =>
  Date.UTC(2026, 2, 2 + day, h, m, s);

const MON = 0;
const TUE = 1;
const WED = 2;
const FRI = 4;
const SAT = 5;
const SUN = 6;
const NEXT_MON = 7;

describe("phaseAt — phase on the canonical schedule", () => {
  it("is peak inside each UTC span", () => {
    expect(phaseAt(at(TUE, 2, 0), canonical).phase).toBe("peak"); // Tue 02:00Z ∈ [01:00, 04:00)
    expect(phaseAt(at(WED, 7, 30), canonical).phase).toBe("peak"); // Wed 07:30Z ∈ [06:00, 10:00)
  });

  it("is off-peak in the gaps", () => {
    expect(phaseAt(at(MON, 0, 30), canonical).phase).toBe("off-peak"); // Mon 00:30Z
    expect(phaseAt(at(MON, 4, 30), canonical).phase).toBe("off-peak"); // Mon 04:30Z
    expect(phaseAt(at(MON, 10, 30), canonical).phase).toBe("off-peak"); // Mon 10:30Z
  });

  it("honours the half-open [start, end) boundaries to ±1 s", () => {
    // Span 01:00–04:00
    expect(phaseAt(at(MON, 0, 59, 59), canonical).phase).toBe("off-peak");
    expect(phaseAt(at(MON, 1, 0, 0), canonical).phase).toBe("peak");
    expect(phaseAt(at(MON, 3, 59, 59), canonical).phase).toBe("peak");
    expect(phaseAt(at(MON, 4, 0, 0), canonical).phase).toBe("off-peak");
    // Span 06:00–10:00
    expect(phaseAt(at(MON, 5, 59, 59), canonical).phase).toBe("off-peak");
    expect(phaseAt(at(MON, 6, 0, 0), canonical).phase).toBe("peak");
    expect(phaseAt(at(MON, 9, 59, 59), canonical).phase).toBe("peak");
    expect(phaseAt(at(MON, 10, 0, 0), canonical).phase).toBe("off-peak");
  });

  it("never treats weekends as peak, even at weekday peak clocks", () => {
    expect(phaseAt(at(SAT, 2, 0), canonical).phase).toBe("off-peak"); // Sat 02:00Z
    expect(phaseAt(at(SAT, 7, 30), canonical).phase).toBe("off-peak"); // Sat 07:30Z
    expect(phaseAt(at(SUN, 7, 30), canonical).phase).toBe("off-peak"); // Sun 07:30Z
  });
});

describe("phaseAt — next boundary and countdown", () => {
  it("moves to the end of the current span while peak", () => {
    expect(phaseAt(at(MON, 1, 0, 0), canonical).nextSwitchAtMs).toBe(at(MON, 4, 0, 0)); // 01:00 → 04:00
    expect(phaseAt(at(MON, 9, 59, 59), canonical).nextSwitchAtMs).toBe(at(MON, 10, 0, 0)); // 09:59:59 → 10:00
  });

  it("moves to the next span start while off-peak", () => {
    expect(phaseAt(at(MON, 0, 30), canonical).nextSwitchAtMs).toBe(at(MON, 1, 0, 0)); // → 01:00 same day
    expect(phaseAt(at(MON, 4, 30), canonical).nextSwitchAtMs).toBe(at(MON, 6, 0, 0)); // → 06:00 same day
    expect(phaseAt(at(MON, 10, 30), canonical).nextSwitchAtMs).toBe(at(TUE, 1, 0, 0)); // → wrap to Tue 01:00
  });

  it("wraps Friday after 10:00 to Monday 01:00", () => {
    // Fri 10:00:00Z is exactly the end of the last span → off-peak.
    const fridayEnd = phaseAt(at(FRI, 10, 0, 0), canonical);
    expect(fridayEnd.phase).toBe("off-peak");
    expect(fridayEnd.nextSwitchAtMs).toBe(at(NEXT_MON, 1, 0, 0)); // Mon 2026-03-09 01:00Z
    expect(fridayEnd.countdownMs).toBe(226_800_000); // 63 h = 2 d 15 h
    expect(phaseAt(at(FRI, 23, 59, 59), canonical).nextSwitchAtMs).toBe(at(NEXT_MON, 1, 0, 0));
  });

  it("wraps the weekend to Monday 01:00", () => {
    const saturday = phaseAt(at(SAT, 12, 0, 0), canonical); // Sat 12:00Z
    expect(saturday.nextSwitchAtMs).toBe(at(NEXT_MON, 1, 0, 0));
    expect(saturday.countdownMs).toBe(133_200_000); // 37 h
    expect(phaseAt(at(SUN, 3, 0, 0), canonical).nextSwitchAtMs).toBe(at(NEXT_MON, 1, 0, 0));
  });

  it("computes countdownMs as nextSwitchAtMs − nowMs for fixed instants", () => {
    expect(phaseAt(at(MON, 0, 30), canonical).countdownMs).toBe(1_800_000); // → 01:00, 30 min
    expect(phaseAt(at(MON, 9, 0, 0), canonical).countdownMs).toBe(3_600_000); // peak → 10:00, 1 h
  });

  it("never returns a next switch at or before now (14-day sweep, 60 s steps)", () => {
    for (let now = at(MON, 0, 0, 0); now < at(NEXT_MON + 7, 0, 0, 0); now += 60_000) {
      const r = phaseAt(now, canonical);
      expect(r.nextSwitchAtMs).toBeGreaterThan(now);
      expect(r.countdownMs).toBe(r.nextSwitchAtMs - now);
    }
  });
});

describe("scheduleFromSpans", () => {
  it("builds the canonical schedule from the canonical \"HH:MM\" strings", () => {
    const built = scheduleFromSpans([
      { weekdays: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
      { weekdays: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
    ]);
    expect(built).toEqual(canonical);
    expect(
      built.spans.map((sp) => [sp.weekdays, sp.startMin, sp.endMin]),
    ).toEqual([
      [[1, 2, 3, 4, 5], 60, 240],
      [[1, 2, 3, 4, 5], 360, 600],
    ]);
  });

  it("throws on a malformed time string instead of producing NaN spans", () => {
    expect(() =>
      scheduleFromSpans([{ weekdays: [1], start: "01:00", end: "04h" }]),
    ).toThrow();
  });
});

describe("localClock — DST-correct rendering (oracle: python3 zoneinfo, pinned)", () => {
  const NY = "America/New_York";

  it("America/New_York across the 2026-03-08 spring-forward week", () => {
    // Pre-jump week (EST, UTC−5)
    expect(localClock(at(MON, 5, 0, 0), NY)).toBe("00:00"); // Mon 05:00Z → NY midnight
    expect(localClock(at(TUE, 13, 30), NY)).toBe("08:30"); // Tue 13:30Z → 08:30 EST
    expect(localClock(at(FRI, 15, 0), NY)).toBe("10:00"); // Fri 15:00Z → 10:00 EST
    // 2026-03-08 (Sun): US DST starts 07:00Z (02:00 EST → 03:00 EDT, UTC−4)
    expect(localClock(at(SUN, 5, 30), NY)).toBe("00:30"); // 05:30Z → 00:30 EST
    expect(localClock(at(SUN, 6, 59, 59), NY)).toBe("01:59"); // last second before the jump
    expect(localClock(at(SUN, 7, 0, 0), NY)).toBe("03:00"); // 07:00Z → 03:00 EDT (02:xx skipped)
    expect(localClock(at(SUN, 8, 0, 0), NY)).toBe("04:00"); // 08:00Z → 04:00 EDT
  });

  it("America/New_York on the 2026-11-01 fall-back (fold) Sunday", () => {
    const cases: Array<[number, string]> = [
      [Date.UTC(2026, 9, 28, 12, 0, 0), "08:00"], // Wed 12:00Z → 08:00 EDT (UTC−4)
      [Date.UTC(2026, 10, 1, 5, 30, 0), "01:30"], // 05:30Z → 01:30 EDT, first pass
      [Date.UTC(2026, 10, 1, 6, 0, 0), "01:00"], // 06:00Z: 02:00 EDT → 01:00 EST
      [Date.UTC(2026, 10, 1, 6, 30, 0), "01:30"], // 06:30Z → 01:30 EST, fold (second pass)
      [Date.UTC(2026, 10, 1, 8, 0, 0), "03:00"], // 08:00Z → 03:00 EST (UTC−5)
    ];
    for (const [ms, expected] of cases) {
      expect(localClock(ms, NY)).toBe(expected);
    }
  });

  it("Asia/Ho_Chi_Minh is a stable UTC+7 with no DST", () => {
    const HCM = "Asia/Ho_Chi_Minh";
    const cases: Array<[number, string]> = [
      [Date.UTC(2026, 5, 14, 17, 30, 0), "00:30"], // 17:30Z → 00:30 next local day
      [Date.UTC(2026, 5, 15, 3, 0, 0), "10:00"], // 03:00Z → 10:00
      [Date.UTC(2026, 11, 25, 23, 45, 0), "06:45"], // 23:45Z → 06:45 next local day
    ];
    for (const [ms, expected] of cases) {
      expect(localClock(ms, HCM)).toBe(expected);
    }
  });

  it("defaults to the system-resolved time zone when tz is omitted or blank (deterministic wiring check)", () => {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(zone.length).toBeGreaterThan(0);
    for (const ms of [at(WED, 7, 30), Date.UTC(2026, 10, 1, 6, 30, 0)]) {
      expect(localClock(ms)).toBe(localClock(ms, zone)); // omitted → resolved zone
      expect(localClock(ms, "")).toBe(localClock(ms, zone)); // config default "" = system local
      expect(localClock(ms)).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("formatCountdown", () => {
  it('renders "Xh Ym" from one hour up', () => {
    expect(formatCountdown(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m"); // 5 h 12 m
    expect(formatCountdown(3_600_000)).toBe("1h 0m"); // exact 1 h stays in hour form
    expect(formatCountdown(18_750_000)).toBe("5h 12m"); // 5 h 12 m 30 s → seconds dropped
  });

  it('renders "Ym Zs" below one hour, including the 60 s boundary', () => {
    expect(formatCountdown(90_000)).toBe("1m 30s");
    expect(formatCountdown(45_000)).toBe("0m 45s");
    expect(formatCountdown(60_000)).toBe("1m 0s"); // 60 s stays in the "Ym Zs" form
    expect(formatCountdown(3_599_999)).toBe("59m 59s"); // 1 s short of an hour
    expect(formatCountdown(0)).toBe("0m 0s");
  });

  it("composes with phaseAt for a full-schedule countdown", () => {
    const r = phaseAt(at(FRI, 10, 0, 0), canonical); // Fri 10:00Z → Mon 01:00Z
    expect(formatCountdown(r.countdownMs)).toBe("63h 0m");
  });
});
