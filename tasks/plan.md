# Implementation Plan — `@ultra-omp/pi-deepseek-statusline`

Task-level breakdown for building the DeepSeek status line extension. Derived from `SPEC.md` (distilled spec, same directory) and `PLAN_DEEPSEEK_STATUS_LINE_PLAN.md` (authoritative engineering detail — every task below cites its PLAN phase/section; where a task is silent, the PLAN governs). Follow this task list in order; checkpoints stop the build for review.

## Overview

Add a new bun-workspace package whose OMP footer status line shows, whenever DeepSeek models are actually in use (per-request attribution, incl. mid-session fallback and subagents): peak/off-peak phase + countdown, per-model prices from the official DeepSeek pricing pages (fetched once per currency, kept forever), remaining balance (key resolved from OMP, never entered), and session cost across the session tree. Zero runtime deps; unit-tested pure engines; entry wiring last.

## Architecture Decisions

1. **Mirror sibling contract exactly** — manifest/files/`omp.extensions` shape, tsconfig, MIT LICENSE, `vitest`; single default-export factory in `extensions/index.ts`; pure modules in `lib/`; tests in `tests/` (one per module). Copy `isDeepSeekModel` semantics from `packages/pi-deepseek-cache/lib/helpers.ts`; **do not** copy its `PRICING_TIERS` constants (no offline prices in this package) and **do not** copy its `theme.fg("dim", …)` status wrapper (status text is plain — ANSI is stripped).
2. **Sources of truth are exclusive** — prices/schedule: the two official locale pages (en USD, zh-cn CNY, trailing slash), fetch-once-forever per currency, refreshed only via `/ds-statusline --force-refresh`; balance: `GET https://api.deepseek.com/user/balance` with the OMP-configured key via `ctx.modelRegistry.getApiKeyForProvider("deepseek")`; cost: usage on `message_end`. No FX, no cross-currency math, no offline constants, no third-party data. No key prompt/env/storage anywhere.
3. **Config primitives move early (order deviation from PLAN, behavior identical).** PLAN Phase 8 builds the whole config surface last; this breakdown pulls only `lib/config.ts` (defaults object, flat-YAML parse, atomic write) forward to Task 3 because the balance cadence, currency rule, and visibility predicate consume those defaults from day one — building them against a `Config` type avoids default-constant churn. The `/ds-statusline` command + dialog wiring stays last (Task 10) exactly as PLAN Phase 8. Veto at review if you prefer strict PLAN order.
4. **Entry is a thin controller + thin factory.** All orchestration (event handling, cadence timers, ledger watching, render composition) lives in a testable controller (`lib/statusline.ts`) with injected `ctx`/timers; `extensions/index.ts` only registers events/commands and delegates. Keeps the one integration task M-sized and unit-testable without a live OMP runtime.
5. **Degrade, never fabricate** — `prices unavailable` / `session n/a` / `+n unpriced` / `bal ✕` / omitted segments are first-class rendered states per SPEC Boundaries.

## Dependency Graph

```
T0 baseline            (none)
 └─ T1 scaffold        (T0)  …also bun install
     ├─ T2 anchors     (T1)  runtime facts → README impl notes → feeds T6/T7
     ├─ T3 config      (T1)  defaults/parse/atomic write
     ├─ T4 window      (T1)  phase/countdown engine          ┐ parallel batch
     └─ T5 pricing     (T1)  fetch/parse/cache + fixtures    ┘ T3∥T4∥T5
         ├─ T6 cost    (T2,T4,T5) ledgers + session cost
         ├─ T7 balance (T2,T3)  key resolution + currency rule
         └─ T8 active  (T3,T6)  visibility predicate
              └─ T9 wiring (T3..T8) status-line controller + entry  → user-visible line
                   ├─ T10 command (T3,T5,T9) /ds-statusline + --force-refresh
                   └─ T11 README (T2,T10) finalize + impl notes
                        └─ T12 verify (T9,T10,T11) full suite + in-app E2E w/ human
```

Sequential: T1→T2, T6→T8→T9, T9→T10→T11→T12. Parallelizable: T3∥T4∥T5 (after T1) and T6∥T7 (after their deps) — safe: separate files, no shared mutation. Entry wiring (T9+) is serial.

## Task List

### Phase 1: Foundation

#### Task 0: Run full-suite baseline
**Description:** Before any scaffold, capture the repo's real green state so "no regressions" is provable later. Requires `bun install` first (repo currently has no `node_modules` — PLAN "Already done").
**Acceptance criteria:**
- `bun install` at repo root completes.
- `bun test` at repo root runs to completion; every failing test is recorded by name (pass/fail counts saved as `local://baseline.md`).
**Verification:** baseline note exists with exact counts + failing-test names; result diffed in Task 12.
**Dependencies:** None.
**Files likely touched:** none in repo (session note `local://baseline.md`).
**Estimated scope:** S.

#### Task 1: Scaffold package + workspace + installer catalog
**Description:** Create `packages/pi-deepseek-statusline` mirroring `packages/pi-deepseek-cache` exactly, register it in the root workspace, regenerate the installer catalog (PLAN Phase 2).
**Acceptance criteria:**
- `packages/pi-deepseek-statusline/` exists with `package.json` (name `@ultra-omp/pi-deepseek-statusline`, version `0.1.0`, `files: ["extensions/","lib/","README.md","LICENSE"]`, `"omp": {"extensions": ["./extensions/index.ts"]}`, scripts `test`/`check` = `vitest run`, peer+dev deps `@oh-my-pi/pi-ai|pi-coding-agent|pi-tui` (`"*"`), `vitest ^3.2.0`, `@types/node ^22.14.0`, author `nntoan`, MIT, repo directory), `tsconfig.json` + `LICENSE` copied from the sibling, README skeleton (features, config, no-key note, Implementation notes placeholder), no-op factory `extensions/index.ts`, one passing smoke test.
- Root `package.json` `workspaces` includes `packages/pi-deepseek-statusline`.
- `bun run sync:installer-catalog` updates `packages/installer/src/catalog.generated.mjs` with the new record; `bun run check:installer-catalog` passes.
- `bun --filter '@ultra-omp/pi-deepseek-statusline' test` passes.
**Verification:** the three commands above green.
**Dependencies:** Task 0.
**Files likely touched:** `packages/pi-deepseek-statusline/{package.json,tsconfig.json,LICENSE,README.md,extensions/index.ts,tests/smoke.test.ts}` (new), root `package.json`, `packages/installer/src/catalog.generated.mjs` (generated, not hand-edited).
**Estimated scope:** M.

#### Task 2: Verify runtime anchors, record in README
**Description:** Close PLAN Phase 1 gaps against the now-installed `@oh-my-pi/*` types; every finding becomes a binding decision recorded in the README "Implementation notes" section (PLAN Phase 1).
**Acceptance criteria:**
- Output-token key resolved from the installed `pi-ai` usage type: first present of `u.output ?? u.completionTokens ?? u.completion_tokens ?? 0`; if none, decision = output unpriced (`+n unpriced` / `(out unpriced)`) — recorded.
- Subagent linkage: whether `ctx.sessionManager` exposes a parent/root-session id; if not, the cwd + 60 s window heuristic is the binding rule — recorded.
- Key accessor confirmed on the installed `ModelRegistry` (`getApiKeyForProvider` present) via a compile probe; provider string for DeepSeek asserted from observed `ctx.model.provider`; any divergence recorded and used in Task 7.
**Verification:** README Implementation notes section contains the three findings; greps/probe output cited there.
**Dependencies:** Task 1.
**Files likely touched:** `packages/pi-deepseek-statusline/README.md`.
**Estimated scope:** S.

### Checkpoint A — Foundation (after Tasks 0–2)
- [ ] Baseline recorded; scaffold + catalog green; `bun --filter '@ultra-omp/pi-deepseek-statusline' test` passes.
- [ ] Three runtime anchors resolved and documented; no open type-shape guesses remain.
- [ ] Human review before building engines (fail-fast on any anchor surprise).

### Phase 2: Pure engines (parallelizable batch)

#### Task 3: Config primitives — `lib/config.ts`
**Description:** Defaults object + dependency-free flat YAML read/write (PLAN Phase 8 lib subset, moved early per Architecture Decision 3).
**Acceptance criteria:**
- Defaults: `enabled: true`, `alwaysShow: false`, `timezone: ""` (blank = system local), `displayCurrency: "auto"` (`auto|USD|CNY`; auto = CNY-first), `balanceRefreshSec: 15`, `balanceRetrySec: 300`.
- Reader tolerates `#` comments, single/double-quoted and bare scalars; unknown keys preserved verbatim; missing/corrupt file → defaults (log once on corrupt, never auto-overwrite).
- Writer is atomic (temp + rename), writes known keys in file order, preserves unknown keys.
- Tests: parse/merge/defaults/corrupt/unknown-keys-preserved/pickup-on-reread/atomic-leaves-no-temp (PLAN Phase 8 test list).
**Verification:** `bun --filter '@ultra-omp/pi-deepseek-statusline' test` — `tests/config.test.ts` green.
**Dependencies:** Task 1.
**Files likely touched:** `packages/pi-deepseek-statusline/lib/config.ts`, `tests/config.test.ts`.
**Estimated scope:** M.

#### Task 4: Window engine — `lib/window.ts`
**Description:** Pure peak/off-peak recurrence over the canonical UTC weekday schedule, countdown, local-clock rendering (PLAN Phase 3 `lib/window.ts`).
**Acceptance criteria:**
- `phaseAt(nowMs, schedule)` → `{phase, nextSwitchAtMs, countdownMs}`: peak iff UTC Mon–Fri ∈ [01:00,04:00) or [06:00,10:00); next boundary = span end in peak, next span start in off-peak, incl. weekday wrap (Fri 10:00 → Mon 01:00; weekends → Mon 01:00).
- `localClock(instantMs, tz)` (IANA; default `Intl.DateTimeFormat().resolvedOptions().timeZone`), DST-correct; `formatCountdown(ms)`: `Xh Ym` > 60 s, `Ym Zs` below.
- Tests: full matrix — peak inside each span; gaps 00:30/04:30/10:30; Fri 10:00 → Mon 01:00; Sat noon → Mon 01:00; boundary ±1 s; countdown values; DST transition week in `America/New_York`; `Asia/Ho_Chi_Minh`.
**Verification:** `tests/window.test.ts` green.
**Dependencies:** Task 1.
**Files likely touched:** `packages/pi-deepseek-statusline/lib/window.ts`, `tests/window.test.ts`.
**Estimated scope:** S.

#### Task 5: Pricing engine — `lib/pricing.ts` + live fixtures
**Description:** Official-page fetch + real-table parser per currency + fetch-once-forever cache (PLAN Phase 3 `lib/pricing.ts`).
**Acceptance criteria:**
- `PRICE_URLS = { USD: "https://api-docs.deepseek.com/quick_start/pricing/", CNY: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" }` (trailing slash mandatory); `fetchPricing(currency)` with injected fetch; parser reads real `<table>` cells into `PricingData {currency, models: {<base-id>: {peak:{inHit,inMiss,out}, offPeak:{…}}}, schedule}` (ids `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`), schedule sentence → canonical UTC spans (zh-cn 北京时间 − 8 h ≡ en), `discount` computed offPeak/peak, never hard-coded. Never assumes USD.
- Cache: `agentDir/extensions/deepseek-statusline/pricing-cache.json` `{entries: {USD?, CNY?}}`, atomic overwrite, served at any age; no TTL; first-fetch failure with no entry → `unavailable` + retry ≤ 5 min while visible; `--force-refresh` = exactly one fetch per cached currency, atomic overwrite, failure keeps old entries.
- Save live fixtures `tests/fixtures/pricing-en-<yyyymmdd>.html` and `pricing-zh-<yyyymmdd>.html` from the trailing-slash URLs (network required; if unreachable, block with evidence — never fabricate). Parser tests assert against fixture values only.
**Verification:** `tests/pricing.test.ts` green — each fixture yields ≥ 1 model with offPeak = 0.5 × peak, correct currency tag, zh ≡ en UTC schedule; fetch-counter cases (cache any age → 0 fetches; no cache + failure → unavailable + retry; success → persisted once; force-refresh → one fetch + atomic overwrite; failed force-refresh keeps old entries).
**Dependencies:** Task 1.
**Files likely touched:** `lib/pricing.ts`, `tests/pricing.test.ts`, `tests/fixtures/pricing-en-*.html`, `pricing-zh-*.html`.
**Estimated scope:** M.

### Checkpoint B — Engines (after Tasks 3–5)
- [ ] Config, window, pricing suites green.
- [ ] Fixtures reflect the live official pages; parser handles real markup; zh ≡ en.
- [ ] Contingency: if live markup differs from the PLAN's verified description, adapt the parser to the actual DOM, keep the normalized `PricingData` contract, record divergence in README Implementation notes — do not alter acceptance output shapes.

#### Task 6: Ledgers + session cost — `lib/usage.ts`, `lib/cost.ts`
**Description:** Per-request usage accumulation into per-session model × phase buckets, ledger persistence, session-tree cost estimate (PLAN Phase 4).
**Acceptance criteria:**
- Accumulate on assistant `message_end` with `.usage` on DeepSeek models: per-session buckets `{modelId, phase: peak|offPeak, cacheHit, cacheMiss, output}`; `phase = phaseAt(event.ts)` from current schedule; no schedule yet → peak bucket (full rate).
- Ledger file `ledger-{sessionId}.json` `{sessionId, cwd, startTs, lastTs, buckets}` under `agentDir/extensions/deepseek-statusline/`; debounced writes ≤ 1/s; 30-day cleanup of ledger files only (never `pricing-cache.json`).
- Cost (`lib/cost.ts`): per bucket `(cacheHit*hit + cacheMiss*miss + output*out)/1e6` against the ONE chosen-currency table, row matched by `modelId.startsWith(key)`, bucket-phase rows; unknown model → tokens unpriced (`+n unpriced`); output token from Task 2 key.
- Session tree: main ledger + ledgers with `cwd === ctx.cwd && startTs >= mainStartTs - 60_000 && lastTs <= now` (or parent-session id filter when Task 2 found one).
- Tests: exact fixture sums per model × phase against both currency fixtures; flash vs pro; boundary-straddling events in own buckets; cache-hit mix; schedule-missing → full-rate peak; unknown model unpriced; subagent-late updates totals.
**Verification:** `tests/usage.test.ts` + `tests/cost.test.ts` green.
**Dependencies:** Tasks 2, 4, 5.
**Files likely touched:** `lib/usage.ts`, `lib/cost.ts`, `tests/usage.test.ts`, `tests/cost.test.ts`.
**Estimated scope:** M.

#### Task 7: Balance + display-currency rule — `lib/balance.ts`
**Description:** Balance fetch keyed by the OMP-resolved DeepSeek provider key; one-currency display resolution (PLAN Phase 5).
**Acceptance criteria:**
- `GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>`; key from `ctx.modelRegistry.getApiKeyForProvider("deepseek")` (fallback: provider string per Task 2); only when a session ctx with `modelRegistry` is captured; never at module load.
- Parse `balance_infos` rows (never sum/convert/compare across currencies). Display rule: config `displayCurrency` `auto` → CNY row present (incl. mixed) → CNY; else USD row → USD; no rows yet → CNY default; USD-only arrival flips auto exactly once; pin `USD|CNY` overrides table + row.
- States: resolver undefined (no DeepSeek auth in OMP) → balance omitted, rest of line unaffected; HTTP 401 → `bal ✕`, retry after `balanceRetrySec`; network error → keep last value silently, retry next cycle. Cadence: every `balanceRefreshSec` while visible + immediate on visibility gain; none while hidden.
- Tests: injected fetch + key resolver — USD-only/CNY-only/mixed success, 401, network error, resolver-undefined (no crash); currency-rule unit cases incl. single late USD-only flip; cadence cases (visible/hidden/immediate).
**Verification:** `tests/balance.test.ts` green.
**Dependencies:** Tasks 2, 3.
**Files likely touched:** `lib/balance.ts`, `tests/balance.test.ts`.
**Estimated scope:** M.

#### Task 8: Visibility predicate — `lib/active.ts`
**Description:** DeepSeek-in-use decision + line visibility rules (PLAN Phase 6).
**Acceptance criteria:**
- `deepseekActive` true iff any: (a) main/subagent ledger `lastTs` within 60 s; (b) current/last main-session `ctx.model` is DeepSeek; (c) session tree has DeepSeek usage this session. Hidden when none and `alwaysShow` false; `alwaysShow: true` pins visible.
- Tests: pure-Codex hidden; DeepSeek `message_end` → visible; subagent ledger touched under Codex main → visible; > 60 s idle + no usage → hidden; `alwaysShow` → visible.
**Verification:** `tests/active.test.ts` green.
**Dependencies:** Tasks 3, 6 (ledger shape).
**Files likely touched:** `lib/active.ts`, `tests/active.test.ts`.
**Estimated scope:** S.

### Checkpoint C — Engines complete (after Tasks 6–8)
- [ ] Ledger/cost, balance, visibility suites green.
- [ ] Cost exact-sum and currency-rule invariants hold per SPEC Success Criteria 4–6.

### Phase 3: Integration

#### Task 9: Status-line controller + entry wiring — `lib/statusline.ts`, `extensions/index.ts`
**Description:** The user-visible line. Controller owns orchestration with injected ctx/timers; factory registers events and delegates (PLAN Phase 7; Architecture Decision 4).
**Acceptance criteria:**
- `session_start`: capture ctx/sessionId; immediate visibility evaluation + balance refresh (if visible); start ticker. `message_end` (assistant, usage, DeepSeek): accumulate, recompute cost, `ctx.ui.setStatus("deepseek", …)` synchronously. `session_shutdown`: `setStatus("deepseek", undefined)`, stop ticker/watch. No balance/fetch work before `session_start`; never at module load.
- 1 s ticker updates only countdown digits. Balance cadence per Task 7. Pricing first-fetch per needed currency only when segment visible. Subagent deltas: `fs.watch` on the ledger dir + 10 s fallback scan while a DeepSeek session is live.
- Render: single key `"deepseek"`, plain text (no ANSI), format per SPEC Code Style example — phase glyph + local next-boundary time + countdown, per-model prices (present rows only), balance, session cost; degrade strings `prices unavailable` / `session n/a` / `+n unpriced` / `bal ✕`/omitted; one currency per line; fits terminal width.
- Handler exceptions surfaced as extension errors, never crash.
- Tests (controller, mocked `ctx.ui` + fake timers): sync setStatus after each usage event (per turn and tool-call step); countdown-only ticks; visibility transitions; balance cadence; ledger-watch recompute; session lifecycle clears state.
**Verification:** `tests/statusline.test.ts` green; `bun --filter '@ultra-omp/pi-deepseek-statusline' test` green.
**Dependencies:** Tasks 3, 4, 5, 6, 7, 8.
**Files likely touched:** `lib/statusline.ts` (new), `extensions/index.ts`, `tests/statusline.test.ts`.
**Estimated scope:** M–L (break renderer into pure `lib/render.ts` only if the controller file exceeds ~350 lines; acceptance unchanged).

### Checkpoint D — Live line (after Task 9) — human demo gate
- [ ] In-app: with a DeepSeek model active, the line renders with correct phase, ticking countdown, official prices, balance (keyless), and session cost updating mid-task.
- [ ] Degrade paths observed (`prices unavailable` before first fetch; no-auth balance omitted).
- [ ] Human review before command/config polish.

### Phase 4: Configuration, docs, final verification

#### Task 10: `/ds-statusline` command + `--force-refresh`
**Description:** In-app configuration surface (no `/settings` contribution exists — command is the native equivalent; PLAN Phase 8 wiring).
**Acceptance criteria:**
- `pi.registerCommand("ds-statusline")`: `--force-refresh` re-fetches + re-parses every cached currency and atomically overwrites `pricing-cache.json`; fetch failure → notify "refresh failed", existing cache kept, never deleted; on success re-render after fetch settles.
- Interactive (no flag): `ctx.ui.askDialog`, falling back to `select`/`input` when unavailable; options: always-show toggle, timezone override (blank = system), display currency (auto/USD/CNY), balance refresh seconds, refresh-prices-now action. Persists atomically via Task 3 writer; `ctx.ui.notify("deepseek-statusline: saved")`; config changes re-render immediately; config re-read on every tick (hand edits apply ≤ 1 s).
- Tests: mocked `ctx.ui` both paths; persisted YAML has right keys/values (comments of a pre-existing file may drop); atomic write leaves no temp file.
**Verification:** `tests/command.test.ts` green; in-app manual: toggle persists to `~/.omp/agent/ds-statusline.yml`, hand-edit flips line ≤ 1 s.
**Dependencies:** Tasks 3, 5, 9.
**Files likely touched:** `extensions/index.ts`, `tests/command.test.ts` (reuses `lib/config.ts`).
**Estimated scope:** M.

#### Task 11: Finalize README + implementation notes
**Description:** Complete the package README (PLAN Phase 8 README list + Phase 1 notes from Task 2).
**Acceptance criteria:**
- README covers: install (`omp plugin install @ultra-omp/pi-deepseek-statusline`), `/ds-statusline` + `--force-refresh`, config fields + defaults incl. the CNY-first `auto` rule, config file path `~/.omp/agent/ds-statusline.yml` (hand-editable; command writes it), the no-key design (balance uses the DeepSeek provider key configured once in OMP settings), feature list, Implementation notes.
- No docs-site or sibling-package changes (repo docs pipeline untouched beyond the already-synced catalog).
**Verification:** `bun run check:installer-catalog` still green; README read-through.
**Dependencies:** Tasks 2, 10.
**Files likely touched:** `packages/pi-deepseek-statusline/README.md`.
**Estimated scope:** S.

### Checkpoint E — Config + docs (after Tasks 10–11)
- [ ] Command suites green; README complete and accurate.
- [ ] Human review before the final verification pass.

#### Task 12: Full verification + in-app E2E (human-in-loop)
**Description:** Prove the whole deliverable per SPEC Success Criteria 1–8 and PLAN Verification, incl. the manual E2E checklist.
**Acceptance criteria:**
- Full repo suite: `bun test` at root green; sibling results identical to Task 0 baseline.
- Manual in-app E2E (SPEC Testing Strategy; PLAN Verification 1–7), executed with the user: (1) Codex-only session → hidden; (2) forced DeepSeek fallback (real quota exhaustion OR temporary project-local `omp config set --local modelRoles.task deepseek/deepseek-v4-flash`, reverted after) → line renders: correct local phase, ticking countdown, prices equal to the page, keyless balance refreshed ~every 15 s while visible, cost updating per turn/tool-call step — currency presentation matches account (mixed auto → ¥ zh-cn; pin USD → $ en); (3) DeepSeek subagent under Codex main → line ≤ ~2 s, cost folds into total; (4) idle > 60 s → hidden; `alwaysShow` → visible; (5) network blocked → forever-cache prices + last balance, no crash; restore → resumes; (6) `/ds-statusline --force-refresh` updates cache `fetchedAt`; OMP restart → no re-fetch; (7) hand-edit YAML (`displayCurrency: USD`) → flips ≤ 1 s; command rewrite preserves other keys; restore `auto`.
- Results recorded (session note); failures → fix or user-approved follow-up.
**Verification:** suite output + completed E2E checklist.
**Dependencies:** Tasks 9, 10, 11.
**Files likely touched:** none (fixes only if a gate fails).
**Estimated scope:** M (verification).

### Checkpoint F — Complete
- [ ] All SPEC Success Criteria 1–8 met; E2E checklist completed with the user.
- [ ] Full suite green, siblings unchanged vs baseline.
- [ ] Final human approval to finish.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Official pricing page markup/URL churn | Med | Trailing-slash canonical URLs; fixtures saved at impl; parser asserts fixture values; cache kept forever; `/ds-statusline --force-refresh`; never fabricate (Task 5) |
| Installed runtime differs from upstream types (usage key, session linkage, key accessor) | Med | Task 2 anchor verification with pre-decided fallbacks recorded in README (PLAN Phase 1 A3b/A3c/A4c) |
| Schedule/weekend/DST math errors | Med | Epoch-instant recurrence + fixed-instant matrix incl. weekday wrap and DST vectors (Task 4) |
| Mid-session fallback invisible to static model fields | Med | Per-request event attribution in controller (Task 9) + ledger-driven visibility (Task 8) |
| Subagent cost/visibility latency | Low | Ledger files + `fs.watch` + 10 s fallback scan (Task 9) |
| Balance key/currency edge cases (401, no auth, mixed CNY+USD) | Low | Degrade states + CNY-first auto rule + pin override, unit-tested (Task 7) |
| E2E requires real fallback trigger | Low | Temporary project-local modelRoles override, reverted after (Task 12, user-approved) |
| Controller task too large | Low | Thin factory + controller + pure renderer split guard at ~350 lines (Task 9) |

## Open Questions

None blocking. E2E (Task 12) temporarily changes the user's local OMP role config — needs the user's go-ahead at that checkpoint (Ask-first boundary: user's own config, not repo). Architecture Decision 3 (config-lib-early reorder vs PLAN Phase 8-last) is flagged for veto at review.
