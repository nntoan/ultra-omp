// tests/balance.test.ts — balance engine: the display-currency rule
// (resolveDisplayCurrency), the single-row picker (balanceRowFor), and
// fetchBalance against an injected fetchImpl returning REAL Response objects.
// Pure: no cache files, no tmp dirs, no network.

import { describe, expect, it, vi } from "vitest";
import {
  BALANCE_URL,
  balanceRowFor,
  fetchBalance,
  resolveDisplayCurrency,
  type BalanceRow,
} from "../lib/balance";

// ─── fixtures ───────────────────────────────────────────────────────────────

const KEY = "sk-test-key";

const row = (currency: "USD" | "CNY", totalBalance: number): BalanceRow => ({
  currency,
  totalBalance,
});

const CNY_ROW = row("CNY", 110); // parseFloat("110.00")
const USD_ROW = row("USD", 12.34); // parseFloat("12.34")

/** Official response envelope — extra fields exercised at every call site. */
function balanceBody(infos: unknown[]): object {
  return { is_available: true, balance_infos: infos };
}

// ─── display-currency rule ──────────────────────────────────────────────────

describe("resolveDisplayCurrency — one displayed currency, never summed or converted", () => {
  it("pins CNY when displayCurrency is configured 'CNY' (USD row present)", () => {
    expect(resolveDisplayCurrency("CNY", [USD_ROW])).toBe("CNY");
    expect(resolveDisplayCurrency("CNY", [CNY_ROW, USD_ROW])).toBe("CNY");
  });

  it("pins USD when displayCurrency is configured 'USD' (CNY row present)", () => {
    expect(resolveDisplayCurrency("USD", [CNY_ROW])).toBe("USD");
    expect(resolveDisplayCurrency("USD", [CNY_ROW, USD_ROW])).toBe("USD");
  });

  it("auto with a CNY row → CNY", () => {
    expect(resolveDisplayCurrency("auto", [CNY_ROW])).toBe("CNY");
  });

  it("auto with mixed CNY+USD rows → CNY (CNY-first)", () => {
    expect(resolveDisplayCurrency("auto", [CNY_ROW, USD_ROW])).toBe("CNY");
    expect(resolveDisplayCurrency("auto", [USD_ROW, CNY_ROW])).toBe("CNY");
  });

  it("auto with only a USD row → USD", () => {
    expect(resolveDisplayCurrency("auto", [USD_ROW])).toBe("USD");
  });

  it("auto with no rows yet → CNY (DeepSeek-native default)", () => {
    expect(resolveDisplayCurrency("auto", [])).toBe("CNY");
  });
});

// ─── single-row picker ──────────────────────────────────────────────────────

describe("balanceRowFor — picks the one displayed row", () => {
  it("returns the row matching the currency", () => {
    const rows = [CNY_ROW, USD_ROW];
    expect(balanceRowFor(rows, "CNY")).toBe(CNY_ROW);
    expect(balanceRowFor(rows, "USD")).toBe(USD_ROW);
  });

  it("returns undefined when no row matches", () => {
    expect(balanceRowFor([USD_ROW], "CNY")).toBeUndefined();
    expect(balanceRowFor([], "USD")).toBeUndefined();
  });
});

// ─── mocked fetch plumbing ──────────────────────────────────────────────────

interface FetchCall {
  url: unknown;
  init?: RequestInit;
}

/**
 * Injectable fetchImpl recording every call and returning a real Response
 * (global under Node ≥18 / bun) — either a JSON `body` or a raw `text` body.
 */
function fetchMock(opts: { body?: unknown; status?: number; text?: string; reject?: boolean } = {}) {
  const { body, status = 200, text, reject = false } = opts;
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (reject) throw new TypeError("simulated network failure");
    return new Response(text !== undefined ? text : JSON.stringify(body), { status });
  });
  return { calls, impl };
}

// ─── fetchBalance ───────────────────────────────────────────────────────────

describe("fetchBalance — GET /user/balance with the Bearer key", () => {
  it("USD-only success: hits BALANCE_URL with the Authorization header and parses the row", async () => {
    const { calls, impl } = fetchMock({
      body: balanceBody([
        { currency: "USD", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" },
      ]),
    });
    const res = await fetchBalance(KEY, { fetchImpl: impl });

    expect(res).toEqual({ ok: true, rows: [USD_ROW] });
    // Exactly one call, to the balance endpoint, carrying the key as a Bearer token.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BALANCE_URL);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("CNY-only success: parses the CNY row", async () => {
    const { impl } = fetchMock({
      body: balanceBody([{ currency: "CNY", total_balance: "110.00" }]),
    });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, rows: [CNY_ROW] });
  });

  it("mixed rows: parses every row in order with parsed totals (extra fields tolerated)", async () => {
    const { impl } = fetchMock({
      body: balanceBody([
        { currency: "CNY", total_balance: "110.00", granted_balance: "0.00", topped_up_balance: "110.00" },
        { currency: "USD", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" },
      ]),
    });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, rows: [CNY_ROW, USD_ROW] });
    if (res.ok) {
      expect(res.rows.map((r) => r.currency)).toEqual(["CNY", "USD"]);
      expect(res.rows.map((r) => r.totalBalance)).toEqual([110, 12.34]);
    }
  });

  it("HTTP 401 → { ok:false, kind:'unauthorized' }", async () => {
    const { calls, impl } = fetchMock({ status: 401, body: { error: "invalid api key" } });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, kind: "unauthorized" });
    expect(calls).toHaveLength(1);
  });

  it("other non-2xx (500) → { ok:false, kind:'http' } with the status in error", async () => {
    const { impl } = fetchMock({ status: 500, body: { error: "boom" } });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, kind: "http", error: expect.stringContaining("500") });
  });

  it("fetch rejection → { ok:false, kind:'network' } (never throws)", async () => {
    const { impl } = fetchMock({ reject: true });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({
      ok: false,
      kind: "network",
      error: expect.stringContaining("simulated network failure"),
    });
  });

  it("invalid JSON body → { ok:false, kind:'parse' }", async () => {
    const { impl } = fetchMock({ text: "<html>gateway error</html>" });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, kind: "parse", error: expect.any(String) });
  });

  it("200 with an empty balance_infos list → { ok:true, rows: [] }", async () => {
    const { impl } = fetchMock({ body: balanceBody([]) });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, rows: [] });
  });

  it("skips rows with an unknown currency (EUR) while keeping valid rows", async () => {
    const { impl } = fetchMock({
      body: balanceBody([
        { currency: "EUR", total_balance: "99.00" },
        { currency: "USD", total_balance: "12.34" },
      ]),
    });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, rows: [USD_ROW] });
  });

  it("skips rows whose total_balance is non-numeric (garbage, empty, prefixed)", async () => {
    const { impl } = fetchMock({
      body: balanceBody([
        { currency: "USD", total_balance: "abc" },
        { currency: "USD", total_balance: "" },
        { currency: "USD", total_balance: "12.34abc" },
        { currency: "USD", total_balance: "12.34" },
      ]),
    });
    const res = await fetchBalance(KEY, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, rows: [USD_ROW] });
  });
});
