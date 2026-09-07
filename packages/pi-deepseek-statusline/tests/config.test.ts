import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  statSync,
} from "node:fs";
import {
  DEFAULT_CONFIG,
  configPath,
  parseConfig,
  readConfigFile,
  writeConfigFile,
} from "../lib/config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ds-statusline-config-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("joins the agent dir with the config file name", () => {
    expect(configPath(dir)).toBe(join(dir, "ds-statusline.yml"));
  });
});

describe("parseConfig", () => {
  it("merges a partial file onto defaults", () => {
    const { config, unknownLines } = parseConfig("alwaysShow: true\nbalanceRefreshSec: 45");
    expect(config).toEqual({
      enabled: true,
      alwaysShow: true,
      timezone: "",
      displayCurrency: "auto",
      balanceRefreshSec: 45,
      balanceRetrySec: 300,
    });
    expect(unknownLines).toEqual([]);
  });

  it("tolerates comments, blank lines, inline comments, and quoted scalars", () => {
    const text = [
      "# comment",
      "",
      "timezone: 'Asia/Ho_Chi_Minh'",
      'displayCurrency: "USD"',
      "balanceRefreshSec: 15   # seconds",
      "enabled: true",
    ].join("\n");
    const { config, unknownLines } = parseConfig(text);
    expect(config).toEqual({
      enabled: true,
      alwaysShow: false,
      timezone: "Asia/Ho_Chi_Minh",
      displayCurrency: "USD",
      balanceRefreshSec: 15,
      balanceRetrySec: 300,
    });
    expect(unknownLines).toEqual([]);
  });

  it("preserves unknown keys verbatim, including nested-looking lines", () => {
    const { config, unknownLines } = parseConfig(
      "enabled: false\nmyCustomKey: some value\nnested:\n  child: 1"
    );
    expect(config).toEqual({
      enabled: false,
      alwaysShow: false,
      timezone: "",
      displayCurrency: "auto",
      balanceRefreshSec: 15,
      balanceRetrySec: 300,
    });
    expect(unknownLines).toEqual(["myCustomKey: some value", "nested:", "  child: 1"]);
  });
});

describe("readConfigFile", () => {
  it("returns defaults and creates nothing when the file is missing", async () => {
    const { config, unknownLines } = await readConfigFile(join(dir, "absent.yml"));
    expect(config).toEqual({ ...DEFAULT_CONFIG });
    expect(unknownLines).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("defaults only the malformed key and never warns", async () => {
    const file = join(dir, "ds-statusline.yml");
    writeFileSync(
      file,
      [
        "enabled: maybe",
        'alwaysShow: "true"',
        'timezone: "unterminated',
        "displayCurrency: eur",
        "balanceRefreshSec: -5",
        "balanceRetrySec: 90",
      ].join("\n")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config, unknownLines } = await readConfigFile(file);
    expect(config).toEqual({
      enabled: true,
      alwaysShow: false,
      timezone: "",
      displayCurrency: "auto",
      balanceRefreshSec: 15,
      balanceRetrySec: 90,
    });
    expect(unknownLines).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns exactly once and never overwrites a structurally corrupt file", async () => {
    const file = join(dir, "corrupt.yml");
    const garbage = "this is not a config file\n%%% not yaml %%%\n";
    writeFileSync(file, garbage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config, unknownLines } = await readConfigFile(file);
    expect(config).toEqual({ ...DEFAULT_CONFIG });
    expect(unknownLines).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, "utf8")).toBe(garbage);
  });

  it("treats an unknown-keys-only file as valid, not corrupt", async () => {
    const file = join(dir, "custom.yml");
    writeFileSync(file, "customOnly: 1\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config, unknownLines } = await readConfigFile(file);
    expect(config).toEqual({ ...DEFAULT_CONFIG });
    expect(unknownLines).toEqual(["customOnly: 1"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("writeConfigFile", () => {
  it("writes known keys in interface order with exact scalar encoding", async () => {
    const file = join(dir, "ds-statusline.yml");
    await writeConfigFile(file, {
      enabled: false,
      alwaysShow: true,
      timezone: "",
      displayCurrency: "USD",
      balanceRefreshSec: 30,
      balanceRetrySec: 120,
    });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: false",
        "alwaysShow: true",
        'timezone: ""',
        "displayCurrency: USD",
        "balanceRefreshSec: 30",
        "balanceRetrySec: 120",
        "",
      ].join("\n")
    );
    await writeConfigFile(file, {
      enabled: false,
      alwaysShow: true,
      timezone: "Asia/Ho_Chi_Minh",
      displayCurrency: "USD",
      balanceRefreshSec: 30,
      balanceRetrySec: 120,
    });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: false",
        "alwaysShow: true",
        "timezone: Asia/Ho_Chi_Minh",
        "displayCurrency: USD",
        "balanceRefreshSec: 30",
        "balanceRetrySec: 120",
        "",
      ].join("\n")
    );
  });

  it("atomically replaces prior content with no leftover temp files", async () => {
    const file = join(dir, "ds-statusline.yml");
    await writeConfigFile(file, {
      enabled: true,
      alwaysShow: false,
      timezone: "UTC",
      displayCurrency: "auto",
      balanceRefreshSec: 15,
      balanceRetrySec: 300,
    });
    const firstIno = statSync(file).ino;
    await writeConfigFile(file, {
      enabled: false,
      alwaysShow: true,
      timezone: "",
      displayCurrency: "CNY",
      balanceRefreshSec: 60,
      balanceRetrySec: 60,
    });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: false",
        "alwaysShow: true",
        'timezone: ""',
        "displayCurrency: CNY",
        "balanceRefreshSec: 60",
        "balanceRetrySec: 60",
        "",
      ].join("\n")
    );
    expect(statSync(file).ino).not.toBe(firstIno);
    expect(readdirSync(dir)).toEqual(["ds-statusline.yml"]);
  });

  it("round-trips preserved unknown lines and drops comments on write", async () => {
    const file = join(dir, "ds-statusline.yml");
    writeFileSync(
      file,
      "# my settings\ntimezone: America/New_York\ncustomThing: abc\nenabled: false\n"
    );
    const first = await readConfigFile(file);
    expect(first.config).toEqual({
      enabled: false,
      alwaysShow: false,
      timezone: "America/New_York",
      displayCurrency: "auto",
      balanceRefreshSec: 15,
      balanceRetrySec: 300,
    });
    expect(first.unknownLines).toEqual(["customThing: abc"]);

    await writeConfigFile(
      file,
      { ...first.config, displayCurrency: "CNY" },
      { preserveLines: first.unknownLines }
    );

    const second = await readConfigFile(file);
    expect(second.config.displayCurrency).toBe("CNY");
    expect(second.config.timezone).toBe("America/New_York");
    expect(second.config.enabled).toBe(false);
    expect(second.unknownLines).toEqual(["customThing: abc"]);
    expect(readFileSync(file, "utf8")).toBe(
      [
        "enabled: false",
        "alwaysShow: false",
        "timezone: America/New_York",
        "displayCurrency: CNY",
        "balanceRefreshSec: 15",
        "balanceRetrySec: 300",
        "customThing: abc",
        "",
      ].join("\n")
    );
    expect(readFileSync(file, "utf8")).not.toContain("# my settings");
  });

  it("cleans up its temp file when the atomic rename fails", async () => {
    mkdirSync(join(dir, "asdir"));
    await expect(writeConfigFile(join(dir, "asdir"), { ...DEFAULT_CONFIG })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["asdir"]);
  });
});
