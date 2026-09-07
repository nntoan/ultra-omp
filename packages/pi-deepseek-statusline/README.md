# @ultra-omp/pi-deepseek-statusline

A DeepSeek status line for OMP: live peak/off-peak pricing window, remaining balance, and running session cost — right in the footer.

## Features

- **Pricing window** — peak/off-peak window with live countdown in local time
- **Active-model price** — the current-phase rate row for the DeepSeek model
  in use, fetched from the official pricing pages
- **Remaining balance** — no API key entry
- **Session cost** — running total, including subagents

## Install

```bash
omp plugin install @ultra-omp/pi-deepseek-statusline
```

The extension activates automatically through OMP's `omp.extensions` manifest
entry; the status line then appears in the footer whenever DeepSeek models are
actually in use. No API key entry is needed anywhere — see
[No-key design](#no-key-design).

## Usage

The line shows itself — no command needed to start it: while DeepSeek is in
use it renders the phase + countdown, the active model's price, balance, and
session cost in the footer, refreshing on its own schedule (see
[Behavior notes](#behavior-notes)). Two commands shape it:

- **`/ds-statusline`** — interactive configuration dialog (falls back to
  native select/input prompts when the dialog surface is unavailable). Options:
  toggle always-show, timezone override (blank = system local), display
  currency (`auto` / USD / CNY), balance refresh seconds, and a "refresh prices
  now" action. Changes are written atomically to
  `~/.omp/agent/ds-statusline.yml` and re-render the line immediately; a
  `deepseek-statusline: saved` notification confirms the write.
- **`/ds-statusline --force-refresh`** — re-fetches and re-parses the official
  DeepSeek pricing page for every cached currency, then atomically overwrites
  `pricing-cache.json`. On fetch failure you get a `refresh failed`
  notification and the existing cache is kept — it is never deleted.

## Configuration

All options live in one flat-YAML file, `~/.omp/agent/ds-statusline.yml` (next
to OMP's own `config.yml`, which this extension never reads or writes). It is
hand-editable — one `key: value` per line, `#` comments welcome — and
`/ds-statusline` writes it for you (comments of a pre-existing file may be
dropped when the command writes). A missing or corrupt file falls back to the
defaults below (a corrupt file is logged once, never auto-overwritten); unknown
keys are preserved verbatim. Any unrecognized `displayCurrency` value behaves
as `auto`.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Whether the status line is shown at all. |
| `alwaysShow` | `false` | Keep the line visible even when the session is idle. |
| `timezone` | `""` | IANA timezone for the phase/boundary clock; blank = system local time. |
| `displayCurrency` | `auto` | Display currency: `auto`, `USD`, or `CNY`. `auto` is **CNY-first**: a CNY balance row present (incl. a mixed CNY+USD account) → CNY; else a USD row → USD; no balance rows yet → CNY (DeepSeek-native default). Pinning `USD` or `CNY` overrides the row-based choice. |
| `balanceRefreshSec` | `15` | Seconds between balance refreshes while the line is visible. |
| `balanceRetrySec` | `300` | Seconds to wait before retrying after a failed or unauthorized balance read. |

Example file:

```yaml
enabled: true
alwaysShow: false
timezone: ""
displayCurrency: auto
balanceRefreshSec: 15
balanceRetrySec: 300
```

## Behavior notes

- **Line format** — one plain-text line in the footer, segments joined with
  ` | `. Glyphs are Unicode (`●` peak / `◐` off-peak); OMP strips ANSI, so no
  colors are used. Example (off-peak, CNY account, off-peak rates):

  ```
  ◐ off-peak →peak 09:00 in 5h 12m | v4-flash ¥1.5m/¥0.05h/¥4.5o | bal ¥110.00 | session ¥2.31
  ```
- **Visibility** — the line shows while DeepSeek is actually in use: a main or
  subagent usage event within the last 60 s, or a DeepSeek model current/last
  active (per-request attribution covers mid-session fallback). Idle > 60 s
  hides it unless `alwaysShow: true`.
- **Pricing window** — phase and next-boundary time come from the official
  DeepSeek weekday schedule (parsed from the pricing pages, never hard-coded),
  rendered in the local clock (`timezone` config). The countdown ticks every
  second; only the countdown digits change between ticks.
- **Prices** — one row only, for the DeepSeek model currently in use (the
  model OMP attributes DeepSeek work to): `<model> <sym><miss>m/<sym><hit>h/<sym><out>o`
  (input cache-miss / cache-hit / output per 1M tokens, `deepseek-` prefixes
  trimmed), at the current phase's rate. Rows are fetched from the official
  pricing pages once per currency and cached forever at
  `~/.omp/agent/extensions/deepseek-statusline/pricing-cache.json`; refreshed
  only by `/ds-statusline --force-refresh`. When no DeepSeek model is active
  (e.g. a Codex main session) or the active model has no fetched row, the
  segment is omitted. Before the first successful fetch (or after a failed
  one) the segment reads `prices unavailable` and is retried on a bounded
  schedule while visible.
- **Balance** — refreshed every `balanceRefreshSec` while visible, and
  immediately on visibility gain. No DeepSeek auth configured in OMP → the
  balance segment is omitted (the rest of the line is unaffected); add the
  provider key once in OMP's provider settings. HTTP 401 → `bal ✕`, retried
  after `balanceRetrySec`. Network errors keep the last value silently and
  retry on the next cycle.
- **Session cost** — running total in the display currency, accumulated from
  `message_end` usage and including subagent sessions (aggregated via shared
  ledger files + a cwd/60 s heuristic). Unpriced tokens surface as
  `+n unpriced`; the segment reads `session n/a` until prices are available.
- **One currency, no FX** — prices, balance, and session cost always render in
  the single display currency; balance rows are never summed or converted
  across currencies.
- **State** — ledger files and the pricing cache live under
  `~/.omp/agent/extensions/deepseek-statusline/`. Ledger files older than
  30 days are cleaned up automatically; the pricing cache is never deleted.

## No-key design

Balance queries reuse the DeepSeek provider key already configured in OMP — this extension never asks for or stores a key.

## Implementation notes

- **A3b — output-token key:** `message_end` assistant messages carry the canonical `Usage` (`MessageEndEvent.message: AgentMessage`, `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:791` → `AssistantMessage.usage: Usage` at `@oh-my-pi/pi-ai/src/types.ts:998`, typed from `@oh-my-pi/pi-catalog/types`), whose output-token key is camelCase `output: number` — `@oh-my-pi/pi-catalog/src/types.ts:105` (`input` :103, `cacheRead` :107, `cacheWrite` :109; no `completionTokens`/`completion_tokens` members exist on the type). Binding: cost code uses `u.output ?? u.completionTokens ?? u.completion_tokens ?? 0` → first present is `u.output`.
- **A3c — subagent session linkage:** `ctx.sessionManager` is `ReadonlySessionManager`, a 22-member `Pick<SessionManager>` (`@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:376-398`; field at `extensibility/extensions/types.ts:471`) exposing only `getCwd, getRecordedCwd, getSessionDir, getSessionId, getSessionFile, getSessionName, getArtifactsDir, getArtifactManager, allocateArtifactPath, saveArtifact, getArtifactPath, getLeafId, getLeafEntry, getEntry, getLabel, getBranch, getHeader, getEntries, getTree, getUsageStatistics, putBlob, putBlobSync` — no `parentSessionId`/`rootSessionId`/`sessionTree` id member (`getHeader()`'s optional `parentSession?: string` at `session/session-entries.ts:49` is the current file's on-disk lineage, not an aggregation id). Binding: cwd + 60 s window heuristic aggregates subagent sessions.
- **A4c — registry key accessor:** `ExtensionContext.modelRegistry: ModelRegistry` (`extensibility/extensions/types.ts:473`) is the installed class `@oh-my-pi/pi-coding-agent/src/config/model-registry.ts:213`, exposing `getApiKeyForProvider(provider: string, sessionId?, options?): Promise<string | undefined>` (:2428), `getApiKey(model: Model<Api>, sessionId?, options?)` (:2390), `hasConcreteAuth(provider: string): boolean` (:2303), `hasConfiguredAuth(model)` (:2285), and `authStorage` (:352). Binding: balance key resolution uses `modelRegistry.getApiKeyForProvider(<provider>)` with `<provider>` defaulting to `"deepseek"`, falling back to the provider string observed on `ctx.model.provider`.
- **A5 — pricing page markup divergence (Task 5):** both locale pages (`…/quick_start/pricing/` en + `…/zh-cn/quick_start/pricing/`, trailing slash REQUIRED — bare paths serve stale "first call" content) were fetched live 2026-09-06 into `tests/fixtures/pricing-{en,zh}-20260906.html` (23,168 / 23,354 bytes). The PLAN described "peak vs off-peak column groups"; the real table has **phase row groups**: a header row of model base ids (`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`) over a rowspan-6 PRICING section where each metric (cache-hit / cache-miss / output, rowspan-2 label) spans TWO rows — `OFF-PEAK`/`空闲时段` first, then `PEAK`/`高峰时段` — each with the three models' prices; a Concurrency Limit row (2500/500/2500) sits in the same columns and is dropped via phase-label detection. `lib/pricing.ts` parses this DOM (rowspan/colspan-expanded grid), reads every number from cells (`$`-prefixed en, `元`-suffixed zh — never converted), and normalizes the zh schedule sentence (北京时间 − 8 h) to the same canonical UTC `Schedule` as en. Values are not hard-coded; fixtures are the only asserted source.

## License

[MIT](LICENSE)
