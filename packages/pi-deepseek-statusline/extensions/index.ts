/**
 * DeepSeek Status Line Extension
 *
 * OMP footer status line for DeepSeek: peak/off-peak pricing window with a
 * local-time countdown, the active model's price, remaining balance, and
 * running session cost (including subagents).
 *
 * Install: omp plugin install @ultra-omp/pi-deepseek-statusline
 */

import { mkdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { configPath, readConfigFile, DEFAULT_CONFIG, type Config } from "../lib/config";
import { registerDsStatuslineCommand } from "../lib/command";
import { cleanupOldLedgers, ledgerDir, ledgerPath, loadLedgersIn, saveLedger } from "../lib/usage";
import { fetchPricing, loadPricingCache, pricingCachePath, savePricingCache } from "../lib/pricing";
import { fetchBalance } from "../lib/balance";
import {
  createStatuslineController,
  type StatuslineController,
  type StatuslineEnv,
  type StatuslineSession,
} from "../lib/statusline";

// Pure config lookups, computed at load — no fetch/balance work here.
const OMP_AGENT_DIR = getAgentDir();
const STATE_DIR = ledgerDir(OMP_AGENT_DIR); // …/extensions/deepseek-statusline
const PRICING_CACHE_FILE = pricingCachePath(OMP_AGENT_DIR);
const CONFIG_FILE = configPath(OMP_AGENT_DIR);

/** Per-session registry: extensions observe multiple sessions in one process. */
interface LiveSession {
  sessionId: string;
  ctx: ExtensionContext; // timers + modelRegistry binding
  controller: StatuslineController;
  /** 1 s config re-read poll (Task 10); cleared at session teardown. */
  configPoll?: ReturnType<ExtensionContext["setInterval"]>;
  /** Signature of the last config pushed by the poll, so only real changes re-push. */
  lastConfigSig?: string;
}
const live = new Map<string, LiveSession>();

function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager?.getSessionId?.() ?? "";
}

/** The controller's structural session view, adapted from the real OMP ctx. */
function sessionView(ctx: ExtensionContext): StatuslineSession {
  return {
    sessionId: sessionIdOf(ctx),
    cwd: ctx.cwd,
    model: ctx.model
      ? { id: ctx.model.id, provider: String((ctx.model as { provider?: unknown }).provider ?? "") }
      : null,
    setStatus: (text) => {
      if (ctx.hasUI) ctx.ui.setStatus("deepseek", text);
    },
  };
}

export default function (pi: ExtensionAPI): void {
  const logger = pi.logger;
  const reportError = (err: unknown): void => {
    logger.error(`ds-statusline: ${err instanceof Error ? err.message : String(err)}`);
  };

  /** Re-read ds-statusline.yml each second and push only real changes. */
  async function pollConfig(entry: LiveSession): Promise<void> {
    let config: Config;
    let unknownLines: string[];
    try {
      ({ config, unknownLines } = await readConfigFile(CONFIG_FILE));
    } catch (err) {
      reportError(err);
      return;
    }
    const sig = JSON.stringify([config, unknownLines]);
    if (entry.lastConfigSig === sig) return;
    entry.lastConfigSig = sig;
    entry.controller.setConfig({ ...DEFAULT_CONFIG, ...config });
  }

  // /ds-statusline command (Task 10): in-app config surface + --force-refresh.
  registerDsStatuslineCommand(pi, {
    configFile: CONFIG_FILE,
    controllerFor: (ctx) => live.get(sessionIdOf(ctx))?.controller,
  });

  /** StatuslineEnv bound to one live session; timers ride ctx so the runtime contains throws and auto-clears at shutdown. */
  function makeEnv(entry: LiveSession): StatuslineEnv {
    return {
      now: () => Date.now(),
      setInterval: (cb, ms) => entry.ctx.setInterval(cb, ms),
      clearInterval: (handle) => entry.ctx.clearTimer(handle as never),
      setTimeout: (cb, ms) => entry.ctx.setTimeout(cb, ms),
      clearTimeout: (handle) => entry.ctx.clearTimer(handle as never),
      loadLedgers: () => loadLedgersIn(STATE_DIR),
      saveLedger: (ledger) =>
        ledger.sessionId !== ""
          ? saveLedger(ledgerPath(OMP_AGENT_DIR, ledger.sessionId), ledger)
          : Promise.resolve(),
      loadPricingCache: () => loadPricingCache(PRICING_CACHE_FILE),
      savePricingCache: (cache) => savePricingCache(PRICING_CACHE_FILE, cache),
      fetchPricing: (currency) => fetchPricing(currency),
      fetchBalance: (key) => fetchBalance(key),
      resolveApiKey: async (provider) => {
        const reg = entry.ctx.modelRegistry;
        if (!reg || typeof reg.getApiKeyForProvider !== "function") return undefined;
        const key = await reg.getApiKeyForProvider(provider);
        return key ?? undefined;
      },
      watchLedgerDir: (onChange) => {
        let closed = false;
        let watcher: FSWatcher;
        try {
          watcher = watch(STATE_DIR, (_eventType, fileName) => {
            if (closed) return;
            onChange(typeof fileName === "string" ? fileName : null);
          });
          watcher.on("error", (err) => {
            logger.error(
              `ds-statusline: ledger dir watch error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        } catch (err) {
          // Missing/unwatchable dir → the controller's 10 s scan is the fallback.
          logger.error(
            `ds-statusline: cannot watch ledger dir ${STATE_DIR}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return () => {
            closed = true;
          };
        }
        return () => {
          closed = true;
          try {
            watcher.close();
          } catch {
            // Already closed — nothing to release.
          }
        };
      },
      reportError,
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const existing = live.get(sessionId);
    if (existing) {
      // Fresh start on a live entry: stop its config poll before shutdown.
      if (existing.configPoll !== undefined) {
        existing.ctx.clearTimer(existing.configPoll);
      }
      existing.controller.shutdown();
      live.delete(sessionId);
    }
    try {
      await mkdir(STATE_DIR, { recursive: true });
    } catch (err) {
      reportError(err);
    }
    cleanupOldLedgers(STATE_DIR).catch(reportError); // 30-day hygiene; never touches the pricing cache

    const entry: LiveSession = {
      sessionId,
      ctx,
      controller: undefined as unknown as StatuslineController, // filled below before registration
    };
    const controller = createStatuslineController(makeEnv(entry));
    entry.controller = controller;
    live.set(sessionId, entry);

    // readConfigFile never throws for a missing/corrupt file — it returns fresh defaults.
    const { config, unknownLines } = await readConfigFile(CONFIG_FILE);
    controller.setConfig({ ...DEFAULT_CONFIG, ...config });
    controller.startSession(sessionView(ctx));
    // Task 10: 1 s config re-read so HAND EDITS to ds-statusline.yml apply
    // without a restart. Seed the signature from the config just pushed so
    // the first tick is a no-op.
    entry.lastConfigSig = JSON.stringify([{ ...DEFAULT_CONFIG, ...config }, unknownLines]);
    entry.configPoll = ctx.setInterval(() => {
      void pollConfig(entry).catch(reportError);
    }, 1_000);
  });

  pi.on("message_end", (event, ctx) => {
    const entry = live.get(sessionIdOf(ctx));
    if (!entry) return;
    if (event.message.role !== "assistant") return;
    // The usage shape lives on the runtime message; keep it local and typed-lite.
    const m = event.message as unknown as {
      model?: string;
      provider?: unknown;
      timestamp?: number;
      completedAt?: number;
      usage?: { cacheRead?: unknown; input?: unknown; output?: unknown };
    };
    if (!m.usage) return;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    entry.controller.messageEnd({
      ts: m.completedAt ?? m.timestamp ?? Date.now(),
      model:
        typeof m.model === "string" && m.model !== ""
          ? { id: m.model, provider: typeof m.provider === "string" ? m.provider : "" }
          : null,
      sessionModel: ctx.model
        ? { id: ctx.model.id, provider: String((ctx.model as { provider?: unknown }).provider ?? "") }
        : null,
      cacheRead: num(m.usage.cacheRead),
      input: num(m.usage.input),
      output: num(m.usage.output),
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const entry = live.get(sessionId);
    if (entry) {
      if (entry.configPoll !== undefined) {
        entry.ctx.clearTimer(entry.configPoll);
      }
      entry.controller.shutdown();
      live.delete(sessionId);
    }
  });
}
