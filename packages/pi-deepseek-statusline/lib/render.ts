// lib/render.ts — pure single-line status renderer for the DeepSeek status
// line. Segments, joined with " | ": pricing window (phase + local-time
// countdown to the next boundary), the ACTIVE model's current-phase price row
// (one row only — the model currently in use), account balance, and the
// running session cost. Purely functional: same input → same output, no I/O,
// no module state, no ANSI, no currency conversion.

import type { Currency, PricingData } from "./pricing";
import { findPricingKey } from "./cost";
import type { SessionCost } from "./cost";
import { formatCountdown, localClock, phaseAt } from "./window";

export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", CNY: "¥" };

export type BalanceRenderState =
  | { kind: "ok"; currency: Currency; total: number }
  | { kind: "unauthorized" }
  | null; // omitted — the segment is dropped entirely

export interface RenderStatusInput {
  /** Epoch ms "now" — drives phase + countdown. */
  nowMs: number;
  /** IANA zone for the next-boundary wall clock; "" or omitted → system local. */
  timezone?: string;
  /** Display-currency pricing table (carries the schedule). null → degrade strings. */
  pricing: PricingData | null;
  balance: BalanceRenderState;
  /** Session-cost estimate in `pricing.currency`. null while pricing is null. */
  sessionCost: SessionCost | null;
  /**
   * Id of the DeepSeek model currently in use (the controller's attributed
   * model). Its pricing row is the ONLY price rendered; null (Codex main,
   * no attribution yet) or an id with no fetched row (legacy deepseek-chat,
   * renamed tier) drops the price segment rather than show a row for a model
   * that is not running.
   */
  activeModelId: string | null;
}

/** Format one price figure: shortest decimal that round-trips (String(n)). */
function formatPrice(n: number): string {
  return String(n);
}

/** Base-key → display label: strip a leading "deepseek-" prefix ("deepseek-v4-flash" → "v4-flash"); else the key verbatim. */
function modelLabel(key: string): string {
  return key.startsWith("deepseek-") ? key.slice("deepseek-".length) : key;
}

/** Render the full single-line status text. Pure: same input → same output, no I/O. */
export function renderStatusText(input: RenderStatusInput): string {
  const segments: string[] = [];

  if (input.pricing !== null) {
    const pricing = input.pricing;
    const win = phaseAt(input.nowMs, pricing.schedule);
    const phaseWord = win.phase;
    const nextWord = win.phase === "peak" ? "off-peak" : "peak";
    const glyph = win.phase === "peak" ? "●" : "◐";
    const hhmm = localClock(win.nextSwitchAtMs, input.timezone || undefined);
    const countdown = formatCountdown(win.countdownMs);
    segments.push(`${glyph} ${phaseWord} →${nextWord} ${hhmm} in ${countdown}`);

    const sym = CURRENCY_SYMBOL[pricing.currency];
    // ONE row, for the model that is actually running — a row per table model
    // would claim prices for models that are not in use. The row is chosen
    // with the same longest-prefix rule the cost engine uses (findPricingKey),
    // so the shown rate is exactly the rate the session cost accrues at.
    const activeKey =
      input.activeModelId !== null ? findPricingKey(input.activeModelId, pricing) : null;
    const phaseRow = win.phase === "peak" ? "peak" : "offPeak";
    const priceParts: string[] = [];
    if (activeKey !== null) {
      const row = pricing.models[activeKey][phaseRow];
      priceParts.push(
        `${modelLabel(activeKey)} ${sym}${formatPrice(row.inMiss)}m/${sym}${formatPrice(row.inHit)}h/${sym}${formatPrice(row.out)}o`,
      );
    }
    segments.push(priceParts.join(" · "));
  } else {
    segments.push("prices unavailable");
  }

  if (input.balance !== null) {
    if (input.balance.kind === "unauthorized") {
      segments.push("bal ✕");
    } else {
      segments.push(`bal ${CURRENCY_SYMBOL[input.balance.currency]}${input.balance.total.toFixed(2)}`);
    }
  }

  if (input.pricing === null || input.sessionCost === null) {
    segments.push("session n/a");
  } else {
    const sym = CURRENCY_SYMBOL[input.pricing.currency];
    segments.push(`session ${sym}${input.sessionCost.total.toFixed(2)}`);
    if (input.sessionCost.unpricedTokens > 0) {
      segments.push(`+${input.sessionCost.unpricedTokens} unpriced`);
    }
  }

  return segments.filter((segment) => segment !== "").join(" | ");
}
