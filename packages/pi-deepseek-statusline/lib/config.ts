/**
 * Flat-YAML config primitives for `@ultra-omp/pi-deepseek-statusline`.
 *
 * The on-disk config (`ds-statusline.yml`) is a line-oriented subset of YAML:
 * one `key: value` per line, no nesting, no multi-line scalars, no anchors.
 *
 * Parsing rules (see `parseConfig`): a leading `\uFEFF` BOM is stripped; lines
 * are split on `/\r?\n/`. Blank lines and `#` comment lines are skipped and
 * never reported. A line must match `^\s*([A-Za-z0-9_.-]+)\s*:(.*)$`; the six
 * known keys below are matched case-sensitively and override their default
 * (later lines win), unknown keys are preserved verbatim (including leading
 * whitespace) in `unknownLines`, and any other line makes the whole file
 * structurally corrupt (`TypeError`). Value syntax: bare scalars, single
 * quoted scalars (`''` escapes `'`), and double quoted JSON-escaped scalars
 * are accepted, with an optional trailing inline `#` comment on bare values.
 * A malformed value for a known key never throws: that key keeps its current
 * (default) value and parsing continues.
 *
 * Writing (see `writeConfigFile`) emits the known keys in interface order
 * with YAML scalar encoding, appends preserved unknown lines verbatim, drops
 * all comments, and replaces the target atomically via a temp file in the
 * same directory followed by `rename`.
 *
 * Only Node built-ins are used (`node:fs/promises`, `node:path`); no file is
 * ever read or written outside the explicit `filePath` arguments, and parent
 * directories are never created.
 */

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

/**
 * Parsed flat-YAML configuration for the DeepSeek status line.
 *
 * `timezone` uses IANA names; `""` means system local time. `displayCurrency`
 * accepts `"auto"`, `"USD"`, or `"CNY"`; anything else written by a caller is
 * rejected by the type but the writer still serializes whatever string it is
 * given.
 */
export interface Config {
  /** Whether the status line is shown at all. */
  enabled: boolean;
  /** Whether the status line is shown even when the session is idle. */
  alwaysShow: boolean;
  /** IANA timezone for the status line; `""` = system local. */
  timezone: string;
  /** Currency shown for DeepSeek prices: `"auto"`, `"USD"`, or `"CNY"`. */
  displayCurrency: "auto" | "USD" | "CNY";
  /** How often (seconds) the balance/pricing window refreshes. */
  balanceRefreshSec: number;
  /** How long (seconds) to wait before retrying after a failed balance read. */
  balanceRetrySec: number;
}

/**
 * The frozen default configuration:
 * `{ enabled: true, alwaysShow: false, timezone: "", displayCurrency: "auto",
 * balanceRefreshSec: 15, balanceRetrySec: 300 }`.
 *
 * Every API that "returns defaults" returns a fresh copy (`{ ...DEFAULT_CONFIG }`),
 * never this constant itself.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enabled: true,
  alwaysShow: false,
  timezone: "",
  displayCurrency: "auto",
  balanceRefreshSec: 15,
  balanceRetrySec: 300,
});

/**
 * Matches the key part of a flat-YAML line. Leading whitespace is tolerated so
 * indented nested-looking lines of hand-written YAML stay parseable (they are
 * preserved as unknown lines rather than treated as corruption). The value is
 * everything after the first `:` of the original line.
 */
const KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*:(.*)$/;

/** Bare (unquoted) numeric scalar grammar for the two `*Sec` keys. */
const NUMBER_RE = /^[0-9]+(\.[0-9]+)?$/;

/** Bare (unquoted) scalar grammar that needs no quoting when written. */
const BARE_STRING_RE = /^[A-Za-z0-9_][A-Za-z0-9_./+@-]*$/;

/** A successfully decoded scalar value and whether it was quoted in the file. */
interface ParsedValue {
  text: string;
  quoted: boolean;
}

/**
 * Decodes a single-quoted YAML scalar (`''` inside is an escaped `'`). After
 * the closing quote only a `#` comment or end of line is allowed. Returns
 * `null` when the scalar is malformed.
 */
function parseSingleQuoted(value: string): ParsedValue | null {
  let content = "";
  let i = 1;
  while (i < value.length) {
    const q = value.indexOf("'", i);
    if (q === -1) return null; // unterminated
    if (value[q + 1] === "'") {
      content += value.slice(i, q) + "'";
      i = q + 2;
    } else {
      content += value.slice(i, q);
      const rest = value.slice(q + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) return null;
      return { text: content, quoted: true };
    }
  }
  return null; // unterminated
}

/**
 * Decodes a double-quoted JSON-escaped YAML scalar. Scans to the closing `"`
 * respecting `\` escapes; after it only a `#` comment or end of line is
 * allowed. The quoted token (quotes included) is decoded with `JSON.parse`
 * (`\uXXXX`, `\"`, `\\`, `\n`, … are all valid). Returns `null` when
 * malformed.
 */
function parseDoubleQuoted(value: string): ParsedValue | null {
  let i = 1;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === '"') {
      const token = value.slice(0, i + 1);
      const rest = value.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) return null;
      try {
        const decoded: unknown = JSON.parse(token);
        // A JSON text that starts with `"` can only decode to a string.
        if (typeof decoded !== "string") return null;
        return { text: decoded, quoted: true };
      } catch {
        return null;
      }
    } else {
      i += 1;
    }
  }
  return null; // unterminated
}

/**
 * Parses the value part of a `key: value` line (everything after the first
 * `:`). Leading `[ \t]` is trimmed, then: empty -> `""`; `'…'` single-quoted;
 * `"…"` double-quoted; otherwise a bare scalar cut at the first `[ \t]+#`
 * inline comment (a bare value starting with `#` yields `""`) and trimmed of
 * trailing whitespace. Returns `null` for any malformed quoted value.
 */
function parseValue(valuePart: string): ParsedValue | null {
  const value = valuePart.replace(/^[ \t]+/, "");
  if (value === "") return { text: "", quoted: false };
  if (value[0] === "'") return parseSingleQuoted(value);
  if (value[0] === '"') return parseDoubleQuoted(value);
  let bare = value;
  if (bare.startsWith("#")) {
    bare = "";
  } else {
    const cut = bare.search(/[ \t]+#/);
    if (cut !== -1) bare = bare.slice(0, cut);
  }
  return { text: bare.trimEnd(), quoted: false };
}

/**
 * Applies the value part of a `key: value` line to one known key of `config`.
 * A malformed quoted value, or a value that violates the key's type rules,
 * leaves the key at its current value — never throws, never aborts parsing.
 * Only ever called with one of the six known keys (the caller switches first).
 */
function applyKnownKey(config: Config, key: string, valuePart: string): void {
  const parsed = parseValue(valuePart);
  if (parsed === null) return;
  const { text, quoted } = parsed;
  switch (key) {
    case "enabled": {
      if (!quoted) {
        const lower = text.toLowerCase();
        if (lower === "true") config.enabled = true;
        else if (lower === "false") config.enabled = false;
      }
      return;
    }
    case "alwaysShow": {
      if (!quoted) {
        const lower = text.toLowerCase();
        if (lower === "true") config.alwaysShow = true;
        else if (lower === "false") config.alwaysShow = false;
      }
      return;
    }
    case "timezone": {
      config.timezone = text; // any decoded text is valid, including ""
      return;
    }
    case "displayCurrency": {
      if (text === "auto" || text === "USD" || text === "CNY") {
        config.displayCurrency = text;
      }
      return;
    }
    case "balanceRefreshSec": {
      if (!quoted && NUMBER_RE.test(text)) {
        const n = Number(text);
        if (Number.isFinite(n) && n >= 0) config.balanceRefreshSec = n;
      }
      return;
    }
    case "balanceRetrySec": {
      if (!quoted && NUMBER_RE.test(text)) {
        const n = Number(text);
        if (Number.isFinite(n) && n >= 0) config.balanceRetrySec = n;
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Parses flat-YAML config text into a fresh `{ config, unknownLines }` result.
 *
 * A leading `\uFEFF` BOM is stripped, then the text is split on `/\r?\n/`.
 * Per line: blank lines and lines whose trimmed form starts with `#` are
 * skipped (comments are never reported). A line must match
 * `^\s*([A-Za-z0-9_.-]+)\s*:(.*)$`; otherwise the file is structurally
 * corrupt and a `TypeError` (`unparseable config line: <json>`) is thrown.
 *
 * The six known keys are handled case-sensitively; later lines win. Booleans
 * (`enabled`, `alwaysShow`) require unquoted bare `true`/`false`
 * (case-insensitive) — quoted booleans are invalid. `timezone` accepts any
 * decoded text. `displayCurrency` must decode to exactly `auto`, `USD`, or
 * `CNY` (quoted allowed). The two `*Sec` numbers require unquoted bare text
 * matching `/^[0-9]+(\.[0-9]+)?$/` that parses finite and `>= 0`. A malformed
 * value never throws — that key keeps its current value and parsing continues.
 *
 * Unknown keys push their ORIGINAL full line (leading whitespace and trailing
 * spaces included, minus the line terminator) verbatim onto `unknownLines`
 * without parsing the value. Returns a fresh merged `config` object — never
 * the frozen `DEFAULT_CONFIG` itself.
 */
export function parseConfig(text: string): { config: Config; unknownLines: string[] } {
  const config: Config = { ...DEFAULT_CONFIG };
  const unknownLines: string[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    const match = KEY_RE.exec(line);
    if (match === null) {
      throw new TypeError(`unparseable config line: ${JSON.stringify(line)}`);
    }
    const key = match[1];
    switch (key) {
      case "enabled":
      case "alwaysShow":
      case "timezone":
      case "displayCurrency":
      case "balanceRefreshSec":
      case "balanceRetrySec":
        applyKnownKey(config, key, match[2]);
        break;
      default:
        unknownLines.push(line);
        break;
    }
  }
  return { config, unknownLines };
}

/**
 * Reads and parses the config file at `filePath`.
 *
 * A missing file (`ENOENT`) returns `{ config: { ...DEFAULT_CONFIG },
 * unknownLines: [] }` silently — no warning, and the file is never created.
 * Any other read error (e.g. `EACCES`, `EISDIR`) warns once and returns
 * defaults plus `[]`. Content that parses returns `parseConfig`'s result
 * as-is (value-malformed files flow through its per-key defaulting rules).
 * When `parseConfig` throws (structurally corrupt file) the file is NEVER
 * overwritten: `console.warn` fires exactly once (with the file path and
 * message) and defaults plus `[]` are returned.
 */
export async function readConfigFile(
  filePath: string
): Promise<{ config: Config; unknownLines: string[] }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG }, unknownLines: [] };
    }
    console.warn(
      `ds-statusline: cannot read config file ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { config: { ...DEFAULT_CONFIG }, unknownLines: [] };
  }
  try {
    return parseConfig(text);
  } catch (err) {
    if (err instanceof TypeError) {
      console.warn(`ds-statusline: corrupt config file ${filePath}: ${err.message}`);
      return { config: { ...DEFAULT_CONFIG }, unknownLines: [] };
    }
    throw err;
  }
}

/**
 * Encodes a string scalar for the flat-YAML output: written bare when it
 * matches `/^[A-Za-z0-9_][A-Za-z0-9_./+@-]*$/` (e.g. `Asia/Ho_Chi_Minh`,
 * `auto`, `USD`, `CNY`), otherwise emitted via `JSON.stringify` (so `""`,
 * colons, `#` and spaces become double-quoted JSON-escaped scalars).
 */
function encodeString(value: string): string {
  return BARE_STRING_RE.test(value) ? value : JSON.stringify(value);
}

/**
 * Serializes `config` and writes it to `filePath` ATOMICALLY.
 *
 * Output: the six known keys in exactly the interface order — `enabled`,
 * `alwaysShow`, `timezone`, `displayCurrency`, `balanceRefreshSec`,
 * `balanceRetrySec` — one `key: value` per line, then
 * `opts.preserveLines` (default `[]`) appended verbatim one per line in the
 * given order. Booleans are bare `true`/`false`, numbers are bare decimal,
 * strings are bare when they match the safe scalar grammar and
 * `JSON.stringify`-quoted otherwise. Lines are joined with `"\n"` and the
 * content ends with a single trailing `"\n"`. Comments are intentionally
 * dropped on write (the writer emits no header comment; preserved lines are
 * unknown-key lines only).
 *
 * The write is atomic: content goes to a temp file in the SAME directory
 * (`basename(filePath) + "." + process.pid + Date.now().toString(36) +
 * Math.random().toString(36).slice(2) + ".tmp"`), then `rename` replaces the
 * target. On ANY failure after temp creation the temp is unlinked (unlink
 * errors ignored) and the original error is rethrown — a failure leaves no
 * temp file behind. Parent directories are never created.
 */
export async function writeConfigFile(
  filePath: string,
  config: Config,
  opts?: { preserveLines?: string[] }
): Promise<void> {
  const preserveLines = opts?.preserveLines ?? [];
  const content =
    [
      `enabled: ${config.enabled ? "true" : "false"}`,
      `alwaysShow: ${config.alwaysShow ? "true" : "false"}`,
      `timezone: ${encodeString(config.timezone)}`,
      `displayCurrency: ${encodeString(config.displayCurrency)}`,
      `balanceRefreshSec: ${String(config.balanceRefreshSec)}`,
      `balanceRetrySec: ${String(config.balanceRetrySec)}`,
      ...preserveLines,
    ].join("\n") + "\n";
  const suffix = `${process.pid}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const tempPath = join(dirname(filePath), `${basename(filePath)}.${suffix}.tmp`);
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup only: the temp may never have been created.
    }
    throw err;
  }
}

/**
 * Returns the config file path for an agent directory:
 * `join(agentDir, "ds-statusline.yml")`.
 */
export function configPath(agentDir: string): string {
  return join(agentDir, "ds-statusline.yml");
}
