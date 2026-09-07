import { describe, it, expect } from "vitest";
import {
  REMINDER_RE,
  parseReminder,
  renderReminder,
  freezeReminder,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Harness reminder grammar (pi-coding-agent 18.1.11, #7404)
//
// The native injector renders src/prompts/system/date-cwd-reminder.md, trims
// it, and prepends it (plus "\n\n") to the FIRST USER message of every
// provider request. The system prompt is harness-owned and byte-stable; this
// block is the only volatile date/CWD byte:
//
//   <system-reminder>
//   Today: {YYYY-MM-DD}; current working directory: '{cwd}'. Do not repeat this information in your reply.
//   </system-reminder>
// ═══════════════════════════════════════════════════════════════════════════

const HARNESS_CWD = "/Users/nntoan/Workspace/data_agentic/ultra-omp";

/** The exact bytes the harness renders (trimmed) for a date/cwd. */
const harnessBlock = (date: string, cwd: string): string =>
  `<system-reminder>\nToday: ${date}; current working directory: '${cwd}'. Do not repeat this information in your reply.\n</system-reminder>`;

// ═══════════════════════════════════════════════════════════════════════════
// REMINDER_RE
// ═══════════════════════════════════════════════════════════════════════════

describe("REMINDER_RE", () => {
  it("matches the exact harness-rendered block and captures date + cwd", () => {
    const content = harnessBlock("2026-09-06", HARNESS_CWD);
    const match = content.match(REMINDER_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-09-06");
    expect(match![2]).toBe(HARNESS_CWD);
  });

  it("matches when the block sits at the start of injected user content", () => {
    const content = `${harnessBlock("2026-09-06", "/tmp/x")}\n\nSolve this.`;
    const match = content.match(REMINDER_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-09-06");
    expect(match![2]).toBe("/tmp/x");
  });

  it("tolerates CRLF line breaks inside the block", () => {
    const content =
      "<system-reminder>\r\nToday: 2026-09-06; current working directory: '/tmp/x'. Do not repeat this information in your reply.\r\n</system-reminder>";
    const match = content.match(REMINDER_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-09-06");
    expect(match![2]).toBe("/tmp/x");
  });

  it("does not match when the block is not at the start of the string", () => {
    const content = `prefix text ${harnessBlock("2026-09-06", "/tmp/x")}`;
    expect(content.match(REMINDER_RE)).toBeNull();
  });

  it("does not match plain user text", () => {
    expect("What is the capital of France?".match(REMINDER_RE)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseReminder
// ═══════════════════════════════════════════════════════════════════════════

describe("parseReminder", () => {
  it("parses a literal harness block into { date, cwd }", () => {
    expect(parseReminder(harnessBlock("2026-09-06", HARNESS_CWD))).toEqual({
      date: "2026-09-06",
      cwd: HARNESS_CWD,
    });
  });

  it("round-trips renderReminder output", () => {
    const rendered = renderReminder("2026-09-06", "/tmp/x");
    expect(parseReminder(rendered)).toEqual({ date: "2026-09-06", cwd: "/tmp/x" });
  });

  it("parses the block when user content follows it", () => {
    const content = `${harnessBlock("2026-09-06", "/tmp/x")}\n\nContinue.`;
    expect(parseReminder(content)).toEqual({ date: "2026-09-06", cwd: "/tmp/x" });
  });

  it("returns undefined for plain content", () => {
    expect(parseReminder("plain user text")).toBeUndefined();
  });

  it("returns undefined when the block is not at the start", () => {
    const content = `intro ${harnessBlock("2026-09-06", "/tmp/x")}`;
    expect(parseReminder(content)).toBeUndefined();
  });

  it("returns undefined for a malformed / truncated block", () => {
    expect(
      parseReminder(
        "<system-reminder>\nToday: 2026-09-06; current working directory: '/tmp/x'.\n</system-reminder>",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the date is not YYYY-MM-DD", () => {
    expect(
      parseReminder(
        "<system-reminder>\nToday: Sept 6 2026; current working directory: '/tmp/x'. Do not repeat this information in your reply.\n</system-reminder>",
      ),
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderReminder
// ═══════════════════════════════════════════════════════════════════════════

describe("renderReminder", () => {
  it("produces the exact harness byte layout", () => {
    expect(renderReminder("2026-09-06", HARNESS_CWD)).toBe(
      harnessBlock("2026-09-06", HARNESS_CWD),
    );
  });

  it("embeds the given date and cwd, including cwd paths with spaces", () => {
    const rendered = renderReminder("2026-09-06", "/Users/nntoan/My Folder");
    expect(rendered).toContain("Today: 2026-09-06;");
    expect(rendered).toContain("current working directory: '/Users/nntoan/My Folder'.");
    expect(parseReminder(rendered)).toEqual({
      date: "2026-09-06",
      cwd: "/Users/nntoan/My Folder",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// freezeReminder — identity & rewrite semantics
// ═══════════════════════════════════════════════════════════════════════════

describe("freezeReminder", () => {
  it("returns the SAME reference when the content has no reminder block", () => {
    const content = "plain user text, no reminder";
    expect(freezeReminder(content, "2026-09-06", "/tmp/x")).toBe(content);
  });

  it("returns the SAME reference when date + cwd already match the target", () => {
    const content = `${harnessBlock("2026-09-06", "/tmp/x")}\n\nBody.`;
    expect(freezeReminder(content, "2026-09-06", "/tmp/x")).toBe(content);
  });

  it("rewrites ONLY the date when the date differs, preserving cwd and tail", () => {
    const body = "Line one\nLine two";
    const input = `${harnessBlock("2026-09-06", "/tmp/x")}\n\n${body}`;
    const frozen = freezeReminder(input, "2026-09-07", "/tmp/x");
    expect(frozen).toBe(`${harnessBlock("2026-09-07", "/tmp/x")}\n\n${body}`);
    expect(frozen).toContain("Today: 2026-09-07;");
    expect(frozen).not.toContain("Today: 2026-09-06;");
  });

  it("rewrites ONLY the cwd when the cwd differs, preserving date and tail", () => {
    const body = "Keep me intact.";
    const input = `${harnessBlock("2026-09-06", "/old/dir")}\n\n${body}`;
    const frozen = freezeReminder(input, "2026-09-06", "/new/dir");
    expect(frozen).toBe(`${harnessBlock("2026-09-06", "/new/dir")}\n\n${body}`);
    expect(frozen).toContain("current working directory: '/new/dir'.");
    expect(frozen).not.toContain("'/old/dir'");
  });

  it("round-trips: re-freezing a rendered reminder to a new date keeps the cwd", () => {
    const frozen = freezeReminder(
      renderReminder("2026-09-06", "/tmp/x"),
      "2026-09-07",
      "/tmp/x",
    );
    expect(frozen).toContain("Today: 2026-09-07;");
    expect(frozen).toContain("current working directory: '/tmp/x'.");
    expect(frozen).not.toContain("Today: 2026-09-06;");
  });

  it("is idempotent — a second freeze on the rewritten block is a same-reference no-op", () => {
    const input = `${harnessBlock("2026-09-06", "/tmp/x")}\n\nBody.`;
    const once = freezeReminder(input, "2026-09-07", "/tmp/x");
    expect(freezeReminder(once, "2026-09-07", "/tmp/x")).toBe(once);
  });

  it("leaves everything after the block byte-identical", () => {
    const body = "\n\nUser question with trailing newline.\n\n";
    const input = `${harnessBlock("2026-09-06", "/tmp/x")}${body}`;
    const frozen = freezeReminder(input, "2026-09-08", "/tmp/y");
    expect(frozen.endsWith(body)).toBe(true);
  });

  it("returns the SAME reference when the block is not at the start", () => {
    const content = `intro ${harnessBlock("2026-09-06", "/tmp/x")}`;
    expect(freezeReminder(content, "2026-09-07", "/tmp/y")).toBe(content);
  });

  it("normalizes a CRLF reminder to the harness \\n layout when freezing", () => {
    const input =
      "<system-reminder>\r\nToday: 2026-09-06; current working directory: '/tmp/x'. Do not repeat this information in your reply.\r\n</system-reminder>\n\nBody.";
    const frozen = freezeReminder(input, "2026-09-07", "/tmp/x");
    expect(frozen).toBe(`${harnessBlock("2026-09-07", "/tmp/x")}\n\nBody.`);
  });

  it("returns the SAME reference for an empty string", () => {
    const content = "";
    expect(freezeReminder(content, "2026-09-06", "/tmp/x")).toBe(content);
  });
});
