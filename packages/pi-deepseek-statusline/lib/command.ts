// lib/command.ts — the /ds-statusline command: the in-app configuration
// surface (no /settings contribution exists; /ds-statusline is the native
// equivalent) plus `--force-refresh` for the official price tables. All I/O
// is injected — the config file path and a context → live-controller lookup —
// so the module is deterministic under test doubles. No node: imports.

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { readConfigFile, writeConfigFile, type Config } from "./config";
import type { StatuslineController } from "./statusline";

// ─── public surface ─────────────────────────────────────────────────────────

export interface DsStatuslineCommandDeps {
  /** Absolute path of the ds-statusline.yml config file (agentDir/ds-statusline.yml). */
  configFile: string;
  /** Live controller for the session issuing the command; undefined when none. */
  controllerFor(ctx: ExtensionCommandContext): StatuslineController | undefined;
}

/**
 * Registers the `ds-statusline` command on `pi`. One pass per invocation:
 * no arguments opens the interactive action menu; `--force-refresh` (or
 * `force-refresh`) re-fetches every cached currency immediately.
 */
export function registerDsStatuslineCommand(pi: ExtensionAPI, deps: DsStatuslineCommandDeps): void {
  pi.registerCommand("ds-statusline", {
    description:
      "Configure the DeepSeek status line (always-show, timezone, currency, balance cadence) or force-refresh official prices",
    handler: async (args, ctx) => {
      const controller = deps.controllerFor(ctx);
      if (controller === undefined) {
        ctx.ui.notify("deepseek-statusline: no active session", "warning");
        return;
      }
      const token = args.trim().toLowerCase();
      if (token === "") {
        await runInteractive(controller, ctx, deps);
        return;
      }
      if (token === "--force-refresh" || token === "force-refresh") {
        await runForceRefresh(controller, ctx);
        return;
      }
      ctx.ui.notify("deepseek-statusline: usage: /ds-statusline [--force-refresh]", "warning");
    },
  });
}

// ─── force-refresh flow ─────────────────────────────────────────────────────

/** Shared by the `--force-refresh` flag and the interactive "refresh prices now" action. */
async function runForceRefresh(
  controller: StatuslineController,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const result = await controller.forceRefreshPrices();
  if (result.ok) {
    ctx.ui.notify(
      result.refreshed.length > 0
        ? `deepseek-statusline: prices refreshed (${result.refreshed.join(", ")})`
        : "deepseek-statusline: no cached prices to refresh",
      "info",
    );
  } else {
    ctx.ui.notify(`deepseek-statusline: refresh failed — ${result.error}`, "error");
  }
}

// ─── interactive flow ───────────────────────────────────────────────────────

/**
 * Single-pass action menu (one menu choice per invocation). Reads the file
 * fresh so hand edits show up in the "currently …" labels; unknown-key lines
 * are preserved verbatim on write.
 */
async function runInteractive(
  controller: StatuslineController,
  ctx: ExtensionCommandContext,
  deps: DsStatuslineCommandDeps,
): Promise<void> {
  const { config, unknownLines } = await readConfigFile(deps.configFile);
  const actions = [
    { id: "alwaysShow", label: `Toggle always-show (currently ${config.alwaysShow ? "on" : "off"})` },
    {
      id: "timezone",
      label: `Change timezone (currently ${config.timezone === "" ? "system local" : config.timezone})`,
    },
    { id: "displayCurrency", label: `Change display currency (currently ${config.displayCurrency})` },
    {
      id: "balanceRefreshSec",
      label: `Change balance refresh seconds (currently ${config.balanceRefreshSec})`,
    },
    { id: "refreshNow", label: "Refresh official prices now" },
    { id: "done", label: "Done" },
  ] as const;

  let picked: string | undefined;
  if (typeof ctx.ui.askDialog === "function") {
    const res = await ctx.ui.askDialog([
      {
        id: "action",
        question: "DeepSeek status line — what would you like to change?",
        header: "ds-statusline",
        options: actions.map((a) => ({ label: a.label })),
      },
    ]);
    if (!res || res.kind !== "submit") return; // cancel or chat-redirect: do nothing
    picked = res.results[0]?.selectedOptions[0];
  } else {
    picked = await ctx.ui.select("DeepSeek status line", actions.map((a) => a.label));
    if (picked === undefined) return; // cancel
  }
  const action = actions.find((a) => a.label === picked);
  if (action === undefined) return;

  let next: Config | null = null;
  switch (action.id) {
    case "alwaysShow":
      next = { ...config, alwaysShow: !config.alwaysShow };
      break;
    case "timezone": {
      const v = await ctx.ui.input(
        "Timezone (IANA name; leave empty for system local time)",
        config.timezone === "" ? "system local" : config.timezone,
      );
      if (v === undefined) return;
      next = { ...config, timezone: v.trim() };
      break;
    }
    case "displayCurrency": {
      const v = await ctx.ui.select("Display currency", ["auto", "USD", "CNY"]);
      if (v === undefined) return;
      next = { ...config, displayCurrency: v as Config["displayCurrency"] };
      break;
    }
    case "balanceRefreshSec": {
      const v = await ctx.ui.input(
        `Balance refresh seconds (currently ${config.balanceRefreshSec})`,
        String(config.balanceRefreshSec),
      );
      if (v === undefined) return;
      const n = Number(v);
      const valid = /^[0-9]+(\.[0-9]+)?$/.test(v) && Number.isFinite(n) && n >= 0;
      if (!valid) {
        ctx.ui.notify("deepseek-statusline: balance refresh seconds must be a number \u2265 0", "warning");
        return;
      }
      next = { ...config, balanceRefreshSec: n };
      break;
    }
    case "refreshNow":
      await runForceRefresh(controller, ctx);
      return; // force-refresh is its own outcome: no persist, no "saved"
    case "done":
      return;
  }
  if (next === null) return;
  await writeConfigFile(deps.configFile, next, { preserveLines: unknownLines });
  controller.setConfig(next);
  ctx.ui.notify("deepseek-statusline: saved", "info");
}
