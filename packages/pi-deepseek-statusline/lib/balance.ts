// lib/balance.ts — DeepSeek account-balance fetch + one-currency display rule.
//
// Source (official DeepSeek docs `/api/get-user-balance`, verified live
// 2026-09-06):
//   GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <key>
// Response: { is_available: boolean, balance_infos: [{ currency: "CNY"|"USD",
// total_balance: string, granted_balance: string, topped_up_balance: string }] }
//
// The balance rows ARE the user-currency determination ("currency first"), but
// the line renders the ONE chosen display currency (resolveDisplayCurrency),
// never converting or summing rows and never comparing currencies numerically
// (a magnitude comparison would need an FX rate — excluded). No env, no
// config, no storage, no user input: the key is the OMP-resolved DeepSeek
// provider key, supplied by the caller (the controller — Task 9). Never called
// at module load; every fetch/parse failure degrades to a structured
// `{ ok: false, kind }` result instead of throwing.

import type { Currency } from "./pricing";

/** DeepSeek account-balance endpoint. */
export const BALANCE_URL = "https://api.deepseek.com/user/balance";

/**
 * One parsed balance row. `totalBalance` is `parseFloat(total_balance)`; rows
 * with an unknown currency or a non-numeric balance are skipped at parse time.
 */
export interface BalanceRow {
  currency: Currency;
  totalBalance: number;
}

/** The `displayCurrency` config surface: `"auto"` or a pinned currency. */
export type DisplayCurrencySetting = "auto" | Currency;

/** A balance fetch/parse outcome. `fetchBalance` never throws. */
export type FetchBalanceResult =
  | { ok: true; rows: BalanceRow[] }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "http"; error: string }
  | { ok: false; kind: "network"; error: string }
  | { ok: false; kind: "parse"; error: string };

/**
 * Resolve the ONE currency the status line shows for a given balance row set.
 *
 * `"auto"` is CNY-first: a CNY row present (including mixed CNY+USD) → CNY;
 * else a USD row → USD; no rows yet → CNY (DeepSeek-native default). `"USD"`
 * and `"CNY"` pin the currency regardless of rows. Any unrecognized setting
 * value (e.g. a hand-edited config file) behaves as `"auto"`.
 *
 * Pure — no I/O, never throws.
 */
export function resolveDisplayCurrency(
  setting: DisplayCurrencySetting,
  rows: readonly BalanceRow[],
): Currency {
  if (setting === "USD" || setting === "CNY") return setting;
  return rows.some((r) => r.currency === "CNY")
    ? "CNY"
    : rows.some((r) => r.currency === "USD")
      ? "USD"
      : "CNY";
}

/**
 * Pick the row of the requested currency. Rows are never summed or converted
 * across currencies — the line shows exactly one row, in one currency. Returns
 * `undefined` when no row matches (and for a currency absent from `rows`).
 */
export function balanceRowFor(
  rows: readonly BalanceRow[],
  currency: Currency,
): BalanceRow | undefined {
  return rows.find((r) => r.currency === currency);
}

/** A full decimal numeric literal — the WHOLE string ("12abc" is not 12). */
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * `parseFloat` of a numeric-literal string; `undefined` when the value is not
 * a full numeric string (empty, `"abc"`, `"12abc"`, non-strings, …).
 */
function parseTotalBalance(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!NUMERIC_RE.test(trimmed)) return undefined;
  const total = parseFloat(trimmed);
  return Number.isNaN(total) ? undefined : total;
}

/**
 * Parse a decoded balance payload into rows. Unknown-currency and non-numeric
 * rows are skipped; extra fields (`is_available`, `granted_balance`,
 * `topped_up_balance`, …) are tolerated; a missing or non-array
 * `balance_infos` yields no rows.
 */
function parseBalancePayload(payload: unknown): BalanceRow[] {
  const infos =
    payload !== null && typeof payload === "object" && "balance_infos" in payload
      ? payload.balance_infos
      : undefined;
  if (!Array.isArray(infos)) return [];
  const rows: BalanceRow[] = [];
  for (const raw of infos) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!("currency" in raw) || !("total_balance" in raw)) continue;
    const { currency, total_balance } = raw;
    if (currency !== "USD" && currency !== "CNY") continue;
    const totalBalance = parseTotalBalance(total_balance);
    if (totalBalance === undefined) continue;
    rows.push({ currency, totalBalance });
  }
  return rows;
}

/**
 * Fetch the DeepSeek account balance for `key` — never throws.
 *
 * - HTTP 401 → `{ ok: false, kind: "unauthorized" }` (line shows `bal ✕`,
 *   retried after `balanceRetrySec` by the caller).
 * - any other non-2xx → `{ ok: false, kind: "http", error }` (the status is
 *   included in `error`).
 * - the fetch itself rejecting (network) → `{ ok: false, kind: "network" }`.
 * - a 2xx body that is not valid JSON → `{ ok: false, kind: "parse" }`.
 * - 2xx → `{ ok: true, rows }`; `rows` is `[]` for `balance_infos: []`.
 *
 * `fetchImpl` is injectable for tests and defaults to the global `fetch`.
 */
export async function fetchBalance(
  key: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<FetchBalanceResult> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(BALANCE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "network", error: `fetch failed: ${detail}` };
  }
  if (res.status === 401) {
    return { ok: false, kind: "unauthorized" };
  }
  if (!res.ok) {
    const detail = res.statusText ? ` ${res.statusText}` : "";
    return { ok: false, kind: "http", error: `HTTP ${res.status}${detail} from ${BALANCE_URL}` };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "parse", error: `invalid balance JSON: ${detail}` };
  }
  return { ok: true, rows: parseBalancePayload(payload) };
}
