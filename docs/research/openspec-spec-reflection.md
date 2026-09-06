# OpenSpec Spec Reflection — Research & Adoption Notes

Status: research record for `SPEC.md` (Agent-Skills SDLC Workflow Hardening, repo-root draft).

This document records the research that shaped the spec's four interlocking changes: (1) explore-before-ask, (2) `docs/spec/<feature>/SPEC.md` layout, (3) a pre-approval reflection gate on a separate OMP model role, and (4) install-time provisioning of that role. It is the write-up required by the spec's success criteria and lives outside the `agent-skills` package (repo root `docs/research/`).

Evidence convention: every load-bearing claim is tagged `CONFIRMED — <source>` (source path/URL inline) or `INFERRED — <reason>`. Sources are enumerated in the final section; the count of distinct CONFIRMED sources is given there.

---

## 1. Purpose and TL;DR of adopted decisions

Research question behind this file: *which parts of OpenSpec (Fission-AI), the reflection-SDD pattern, ulw-plan, and the OMP model-role system should agent-skills adopt for its spec-driven lifecycle, and how does cross-model spec reflection actually work in OMP?*

Adopted:

- **Explore-first**: `/spec` explores the repo and only asks questions exploration cannot answer, using ulw-plan's two-question filters. [CONFIRMED decision: repo `SPEC.md`, "Decision log" + change 1]
- **One-folder-per-feature spec layout** `docs/spec/<feature>/SPEC.md` (capability maps + nested module specs), with legacy fallback and offer-to-migrate. [CONFIRMED decision: repo `SPEC.md`, change 2]
- **Pre-approval reflection gate**: after a spec draft is finalized the agent asks approve-vs-reflect; `spec-reflector` (new read-only persona) reviews drafts, reports 🔴/🟡/💡 findings, the main session reconciles, two non-converging rounds are surfaced. [CONFIRMED decision: repo `SPEC.md`, change 3]
- **Cross-model via OMP model roles**: `agents/spec-reflector.md` declares `model: "@spec-reflector"`; the user maps the role to a provider/model in `modelRoles`. [CONFIRMED decision: repo `SPEC.md`, change 4]
- **Install-time role provisioning**: the ultra-omp installer provisions `modelRoles.spec-reflector` set-if-absent (global by default, project under `--local`), never overriding an existing value and never rewriting the user's config. [CONFIRMED decision: repo `SPEC.md`, change 5 + installer section]

Explicitly NOT adopted:

- OpenSpec CLI, `openspec/changes/`, archive, stores, and its per-tool command scaffolding — no new runtime dependency; the folder convention + skills cover the same ground. [CONFIRMED decision: repo `SPEC.md`, "Tech Stack": "No OpenSpec CLI adoption (research conclusion: our folder convention + skills cover the same ground without a dependency)"]
- ulw-plan's persona/announcement machinery and sticky plan mode.
- The reflection-SDD article's "tasks ≤ 2 hours" rule — task sizing stays with the existing `planning-and-task-breakdown` skill. [INFERRED — recorded as an adoption decision in the spec discussion; SPEC.md's fork list keeps `planning-and-task-breakdown` as the sizing owner]

---

## 2. OpenSpec capabilities vs. our SDLC

OpenSpec facts below are CONFIRMED against the primary sources (README + `docs/explore.md` + `docs/how-commands-work.md`, all `github.com/Fission-AI/openspec` @ main, fetched 2026-09-06). Our side is the agent-skills chain as specified in repo `SPEC.md`.

| Dimension | OpenSpec | Ours (agent-skills after this change) |
|---|---|---|
| Artifact layout | `openspec/changes/<id>/{proposal.md, specs/, design.md, tasks.md}`; finished changes archived to `openspec/changes/archive/<date>-<id>/`. [CONFIRMED — README "See it in action"] | `docs/spec/<feature>/SPEC.md`; multi-module initiatives nest `docs/spec/<initiative>/<module>/SPEC.md`; root `SPEC.md` is the current single spec. [CONFIRMED — repo `SPEC.md` change 2] |
| Workflow | `/opsx:explore → /opsx:propose → /opsx:apply → /opsx:archive` (core profile ships explore/propose/apply/update/sync/archive; expanded adds new/continue/ff/verify/bulk-archive/onboard). [CONFIRMED — README + how-commands-work.md "Which commands do I even have?"] | Gated `SPECIFY → PLAN → TASKS → IMPLEMENT` with human gates, via commands `/spec → /to-plan → /build → /test → /to-review → /ship`. [CONFIRMED — repo `SPEC.md` fork list names spec.md/to-plan.md/build.md; command catalog `packages/agent-skills/commands/` includes build.md/ship.md/test.md/to-plan.md/to-review.md/spec.md] |
| Requirement style | Plain Markdown delta specs: "The app SHALL …" plus `WHEN … / THEN …` scenarios, no special syntax. [CONFIRMED — README "What do the specs actually look like"] | Prose spec (Objective / Success criteria / Boundaries / Open Questions) as today; optional scenario-style testability guidance adopted as a suggestion, not a requirement. [INFERRED — "optional … guidance" is an adoption note from the spec discussion; SPEC.md keeps its prose structure] |
| Phase philosophy | "Fluid not rigid … update any artifact anytime, no rigid phase gates." [CONFIRMED — README] | Explicit phase gates with human approval between draft and build; reflection gate inserted between draft-finalize and approval. [CONFIRMED — repo `SPEC.md` change 3] |
| Cross-repo planning | OpenSpec Stores (beta): plan in a separate repo shared via git push. [CONFIRMED — README "Stores are in beta"] | Out of scope: single-repo plugin package. |
| Tool integrations | 30+ AI assistants; per-tool command files/skills written by `openspec init`. Notably Oh My Pi is a supported target (`…/commands/opsx-<id>.md` style). [CONFIRMED — README "30+ tools"; how-commands-work.md syntax table] | OMP-native skills + commands only (this repo's `packages/agent-skills`). |
| Dependency | npm CLI `@fission-ai/openspec` (requires Node ≥ 20.19.0). [CONFIRMED — README Quick Start] | No new dependency; package stays dependency-free. [CONFIRMED — repo `SPEC.md` "Tech Stack"] |
| Close-out | Archive step merges delta spec into `openspec/specs/` and files the change. [CONFIRMED — README "See it in action"] | No implemented-spec archive/close-out today — flagged as possible future work (§7). [INFERRED — current SDL chain has no archive step; repo `SPEC.md` does not define one] |

**Adoption verdict** — adopt: explore-first; one-folder-per-feature grouping; pre-approval reflection; optional scenario-style testability guidance. Do NOT adopt: the OpenSpec CLI, its `changes/` + archive/stores machinery, or its command scaffolding (rationale: no new dependency; the folder convention + our skills cover grouping and gating without a CLI). Archive/close-out for implemented specs is a possible future addition.

---

## 3. Reflection-SDD findings

Source: Peng Qian, "Reflection SDD: Use a Reflection Harness to Level Up Your OpenSpec Workflow", Data Leads Future, 2026-05-29 (updated 2026-09-01). [CONFIRMED — dataleadsfuture.com/reflection-sdd-…]

- **The diagnosed failure mode is input-level bugs.** Post-implementation code review (`@reviewer` after apply) caught architecture/implementation issues but missed scenario coverage, edge cases, and cross-module updates — the defects entered through unreviewed proposal files. The author frames this as dropping the traditional "requirements review" step between requirements hand-off and coding. [CONFIRMED — article, "Why This Works"]
- **Fix: a reflection agent between propose and apply.** Position: `explore → /opsx-propose → ⬅ (possibly multiple rounds) → /opsx-apply → verify → archive`. The agent reviews every artifact of a change (proposal/design/specs/tasks) for *substantive defects* — things that "cause the implementation to go in the wrong direction, miss critical scenarios, create contradictions, or make acceptance impossible" — while formatting nits are demoted to optional suggestions. [CONFIRMED — article, agent prompt excerpt]
- **Read-only and on a different model.** The example OpenCode agent frontmatter disables writes (`tools: write: false, edit: false, bash: false`), and the author runs it on a different LLM than the primary agent (primary deepseek-v4-pro; reflector kimi k2.6) "to review proposals from a different angle." [CONFIRMED — article, "Introducing the reflection agent"]
- **Severity taxonomy and rationale.** 🔴 Blocking / 🟡 Should Fix / 💡 Suggestion; every issue must state *why it would cause rework or an incident*, point at exact file/requirement/task locations, and be evaluated against the existing spec baseline, not in a vacuum. Anti-patterns: rubber-stamping, nitpicking, jumping to solutions before the problem is acknowledged, ignoring existing specs, vague feedback. [CONFIRMED — article, agent prompt]
- **Reported effect.** After ~1 month of testing the workflow brought DeepSeek-V4-pro (in OpenCode) to "roughly the same level as Claude Opus 4.6"; the cost is extra review time and tokens. [CONFIRMED — article, Introduction]
- **Workflow lock + task granularity rule.** The author's companion workflow skill mandates: no code without a matching `openspec/changes/<id>/` proposal (bug fixes exempt); verify after implementation; archive on completion; "each task in tasks.md should take no more than 2 hours." [CONFIRMED — article, "Locking down the openspec workflow"] The ≤2h rule is NOT adopted here (§1).

Mapping to our change: SPEC.md adopts the position (reflect between draft-finalize and approval), the read-only mandate, the 🔴/🟡/💡 taxonomy, "why it causes rework" rationale, and the different-model requirement — which is what makes the OMP model-role mechanism (§5) load-bearing.

---

## 4. ulw-plan explore-before-ask mechanics

Source: `packages/shared-skills/skills/ulw-plan/SKILL.md` in `code-yeongyu/oh-my-openagent` (branch `dev`), the "Prometheus" planning-consultant skill. [CONFIRMED — raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/packages/shared-skills/skills/ulw-plan/SKILL.md]

- **Outcome-first stance:** "explore a lot, ask few sharp questions — or none," and stop "the moment the plan is done"; one decision-complete plan a downstream worker executes "with zero further interview." Plan mode is sticky — planning never degrades into implementation. [CONFIRMED — SKILL.md, opening + "Plan mode is sticky"]
- **Two filters for every candidate question** [CONFIRMED — SKILL.md, "Universal invariants"]:
  1. *Could collected evidence answer it?* → explore/research instead, and cite — never ask.
  2. *Could stated intent + a defensible default answer it?* → adopt the default, record it, do not ask — **UNLESS it is an owner-decision**, which always survives as a question even when a default exists: anything irreversible / destructive / safety-critical, or a cross-cutting product choice (public config surface, distribution/packaging, external dependency/pinned SHA, data/schema shape, real budget/spend, expected scale, audience/compliance).
- **CLEAR/UNCLEAR intent routing:** CLEAR → ask only the surviving forks; UNCLEAR → research maximally, adopt and announce best-practice defaults, do not offload the job onto the user via extra questions; an explicit user request to be interviewed overrides routing (every fork is then asked). [CONFIRMED — SKILL.md, "INTENT ROUTING"]
- **Not adopted:** the persona ("Prometheus"), the mandatory `ULW-PLAN MODE ENABLED!` announcement, the sticky plan-mode contract, `.omo/` plan artifacts, and the approval-gate script scaffolding. [INFERRED — adoption decision from the spec discussion; SPEC.md change 1 adopts only the explore-first behavior and the filters, phrased in SPEC.md's own terms]

Adopted into `/spec` (SPEC.md change 1): explore the repository (structure, existing code/patterns/specs, conventions, git state) before any clarifying question; evidence-answerable facts are researched and cited, never asked; preferences/tradeoffs are asked only when no defensible default exists; owner-decisions (irreversible, cross-cutting, user-config surface) always surface as questions. [CONFIRMED — repo `SPEC.md`, change 1]

---

## 5. OMP model-role mechanism (the research that unblocked cross-model)

Primary research artifacts: `agent://RoleConfigScout`, `agent://LocalHarnessScout`, `agent://WebDocsScout` (all parented to this repo's Main session, 2026-09-06), cross-checked against the OMP docs fetched below. OMP = Oh My Pi (`can1357/oh-my-pi`); the locally installed harness is `omp`/`@oh-my-pi/pi-coding-agent` 18.1.11.

### 5.1 Built-in roles and alias grammar

- Nine built-in roles: `default | smol | slow | vision | plan | commit | tiny | task | advisor`. [CONFIRMED — RoleConfigScout artifact: `src/config/model-roles.ts` `MODEL_ROLES` (:32); LocalHarnessScout artifact: `dist/types/config/model-roles.d.ts:14`; WebDocsScout artifact: jsdelivr `src/config/model-roles.ts`]
- Alias prefixes: `@` (canonical; `MODEL_ROLE_ALIAS_PREFIX = "@"`), legacy `pi/`, and `*` = the default role. [CONFIRMED — RoleConfigScout artifact: model-roles.ts :9,:12,:15; WebDocsScout artifact: `MODEL_ROLE_ALIAS_PREFIX`]

```yaml
# ~/.omp/agent/config.yml (global) — modelRoles maps a role name to a concrete selector
modelRoles:
  review: openai/gpt-5.4:high   # docs example: role -> provider/model[:thinking]
```

### 5.2 Agent frontmatter `model:` — where a subagent gets its model

- Task-agent definitions (user `~/.omp/agent/agents/*.md`, project `.omp/agents/*.md`, bundled agents) are Markdown + YAML frontmatter. The optional `model` field "accepts one selector, CSV, or an array. Entries are tried in order after role aliases are expanded." [CONFIRMED — github.com/can1357/oh-my-pi `docs/task-agent-discovery.md`, "Agent definition shape" + "Role-backed custom agents"]
- Dispatch does not carry a per-item model: "For model routing, task dispatch sets only `agent`; it does not set a worker model" — the task wire schema (`TaskItem`/`TaskParams`) has no model/role field, matching the bundled agents' role-alias pins (`task` → `@task`, `scout`/`sonic` → `@smol`, `reviewer` → `@slow`). The resolved model surfaces only in result telemetry (`modelRole`/`resolvedModel`). [CONFIRMED — task-agent-discovery.md; LocalHarnessScout artifact: `dist/types/task/types.d.ts` TaskItem :98-115 / TaskParams :225, `src/task/agents.ts` :43-70]

Our new persona therefore declares the role alias and lets the user's `modelRoles` map decide the actual model — never a hardcoded provider/model (SPEC.md "Code Style": "never hardcode a concrete provider/model into the agent file"):

```markdown
---
name: spec-reflector
description: Read-only reviewer of spec drafts (🔴/🟡/💡 findings).
model: "@spec-reflector"
---
```

### 5.3 Custom roles via the `modelRoles` settings map

- Roles are configured in the settings key `modelRoles: Record<string, string>`; custom role names (e.g. `review`, `fast`, `good` — or our `spec-reflector`) are just extra keys. [CONFIRMED — task-agent-discovery.md "Role-backed custom agents": `/model`'s Roles view "can assign and persist custom role mappings such as `review`, `fast`, and `good`"; RoleConfigScout artifact: settings-schema.d.ts `modelRoles: record {}`]
- Scope and precedence (lowest → highest): built-in schema defaults < global `~/.omp/agent/config.yml` < project `<cwd>/.omp/config.yml` < CLI overlays (`--config <file>`) < runtime overrides. Missing project roles fall back to global roles; only the `modelRoles` key is writable at project scope, and only under `modelRoleStorage: project`. [CONFIRMED — RoleConfigScout artifact citing docs/settings.md (precedence + "Where writes go"); github.com/can1357/oh-my-pi `docs/settings.md` "Where settings live" table + "Where writes go"]

### 5.4 CRITICAL: an unset custom role does NOT fall back to `default`

- `Settings.getModelRole(role)` returns `string | undefined` with no default-role substitution; every resolver treats an unset role as a skip (returns no model) rather than falling back to `modelRoles.default`. [CONFIRMED — RoleConfigScout artifact: settings.d.ts `getModelRole` :245; model-resolver.ts `resolveRoleSelection`/`resolveModelFromSettings` behavior]
- An unset custom-role alias like `@spec-reflector` is therefore expanded to the literal string and matched as a model selector, which matches nothing → spawn with no model (no throw, no graceful fallback). Only built-ins `smol`/`slow` inherit `modelRoles.default` when unset (added deliberately in can1357/oh-my-pi PR #2338; custom roles have no such branch). [CONFIRMED — RoleConfigScout artifact: `expandRoleAlias`/`resolveConfiguredRolePattern`; WebDocsScout artifact: PR #2338 body]

**Verification step (recorded, to be executed at implementation time):** SPEC.md's Open Questions records this as RESOLVED by source research, with one live-harness runtime check still pending during implementation — spawn an agent whose `model: "@spec-reflector"` is absent from `modelRoles` and record the observed behavior (expected: no model resolves, matching the source-level finding). This doc will be updated with the pass/fail result and observed fallback at that point. [CONFIRMED — repo `SPEC.md`, "Open Questions" + "Testing Strategy"]

**Consequence:** `@spec-reflector` must exist in `modelRoles` for the reflector agent to spawn — hence change 4 (provision the role at install time, §6), not a runtime fallback.

### 5.5 Extensions cannot contribute settings schema

- OMP extensions register tools/commands/keybindings/UI/hooks/providers via `pi.*`; there is no `registerSettings`/settings-contribution API in the shipped types or the extensions doc, and plugin manifests (`package.json#omp`, fallback `#pi`) declare features/tools/extensions — not settings. Plugin-owned state persists in `omp-plugins.lock.json#settings`. [CONFIRMED — RoleConfigScout artifact: extensibility/extensions/types.d.ts capability surface, docs/extensions.md capability list, docs/plugin-manager-installer-plumbing.md on-disk model; LocalHarnessScout artifact: ExtensionAPI :815-1052]
- Consequence: the `spec-reflector` role cannot be contributed by the agent-skills extension/plugin at runtime — it must be provisioned into the user's settings at install time (§6). [INFERRED — direct corollary of the CONFIRMED no-settings-contribution finding]

### 5.6 CLI provisioning surface (observed)

```text
$ omp config set --help        # 2026-09-06 live probe
USAGE
  $ omp config [ACTION] [KEY] [VALUE...] [FLAGS]
ARGUMENTS
  ACTION   Config action (list|get|set|reset|path|init-xdg)
  KEY      Setting key
  VALUE    Value (for set/reset)
FLAGS
      --json  Output JSON
```

- `omp config get modelRoles --json` returns the effective record (verified live: type `record`, containing this machine's keys — see §5.7). `omp config set <key> <value>` parses `<value>` against the key's schema type and writes the global file; ordinary writes never touch `<cwd>/.omp/config.yml` except the `modelRoles` project path under `modelRoleStorage: project`. [CONFIRMED — docs/settings.md "Subcommands" + "Where writes go"; live `omp config get modelRoles --json`]
- Open implementation probes (SPEC.md Open Questions): whether `omp config set modelRoles.spec-reflector <selector>` accepts a record subkey as a "real schema path" (docs only demonstrate scalar keys and whole-record JSON values), and how project scope is selected given no scope flag is exposed in help (hypothesis: `cwd`-scoped invocation inside the project directory). Both are resolved during installer implementation by probing `omp config set --help`/behavior; the findings belong in the installer work, not this doc. [INFERRED — from observed `--help` output + docs/settings.md value-parsing table; recorded as open in repo SPEC.md]

### 5.7 Worked example — this machine's real `modelRoles` (example, not universal)

The local global config used to produce this spec shows an OMP role map in the wild; it is one user's layout, included to make the mechanism concrete, not a template we distribute (SPEC.md "Never": no wholesale config bring-over):

```yaml
# /Users/nntoan/.omp/agent/config.yml (local example — provider/model choices are user-specific)
modelRoles:
  designer: openai-codex/gpt-5.6-terra
  tiny: openai-codex/gpt-5.6-luna:off
  plan: openai-codex/gpt-5.6-luna:max
  smol: openai-codex/gpt-5.6-luna:medium
  slow: openai-codex/gpt-5.6-luna:xhigh
  advisor: openai-codex/gpt-5.6-terra
  default: openai-codex/gpt-5.6-luna:high
  task: openai-codex/gpt-5.6-luna:high
  PREWALK: openai-codex/gpt-5.6-luna
retry:
  fallbackChains:
    default: [deepseek/deepseek-v4-flash:high]
    smol:    [deepseek/deepseek-v4-flash:high]
    slow:    [deepseek/deepseek-v4-flash:max]
    advisor: [deepseek/deepseek-v4-pro]
    # …per-role retry fallbacks omitted
```

[CONFIRMED — /Users/nntoan/.omp/agent/config.yml modelRoles block (lines 78–87) + retry.fallbackChains (94–113); echoed by `omp config get modelRoles --json` (LocalHarnessScout artifact + live probe). Role names `designer`/`PREWALK` here are this user's custom entries — further evidence that arbitrary custom roles are ordinary `modelRoles` keys.]

---

## 6. Provisioning design (adopted in SPEC.md)

Because (§5.4) an unset `@spec-reflector` yields no model and (§5.5) no extension can register the role, the ultra-omp installer provisions it as a post-install step when `agent-skills` is installed:

- **Set-if-absent, idempotent:** writes only the single key `modelRoles.spec-reflector`; re-running install is a no-op; a pre-existing user-set value is preserved untouched. [CONFIRMED decision: repo `SPEC.md`, change 5 + success criteria]
- **Seed value order:** `ULTRA_OMP_SPEC_REFLECTOR_MODEL` env override → existing `modelRoles.advisor` → `modelRoles.slow` → `modelRoles.default`; if none of those exist, skip provisioning (spawn-safety over inventing a provider the user may not have). True cross-model review requires the user to later point the role at a second provider — documented here and in the spec. [CONFIRMED decision: repo `SPEC.md`, "Open Questions" seed order]
- **Scope:** global config by default; project scope under `--local` (project file `<cwd>/.omp/config.yml`, the one settings key writable at project scope). [CONFIRMED decision: repo `SPEC.md`, change 5; write-path rules CONFIRMED in docs/settings.md "Where writes go"]
- **Never:** overwrite a user value, rewrite the user's config wholesale, or ship personal/machine-specific config (provider order, themes, advisor flags) as an install template — only the single role key ships. [CONFIRMED decision: repo `SPEC.md`, "Ask first" + "Never"]
- **Mechanism:** `omp config set` (per §5.6); exact record-subkey and project-scope invocation resolved during installer implementation. Verification gate: `omp config get modelRoles --json` before/after install, then a re-run for idempotency. [CONFIRMED decision: repo `SPEC.md`, "Commands"]

---

## 7. Adoption summary and open items

| Source | We take | We leave |
|---|---|---|
| OpenSpec | Explore-first discipline, one-folder-per-feature grouping, scenario-style testability guidance (optional) | CLI, changes/ + archive/stores machinery, 30+-tool command scaffolding |
| Reflection-SDD | Pre-approval reflection on a different model, read-only, 🔴/🟡/💡 with "why it causes rework", multiple rounds with explicit non-convergence | ≤2h task-granularity rule |
| ulw-plan | Two question filters (evidence-answerable → research; defensible default → adopt unless owner-decision), explore-before-ask | Persona/announcement machinery, sticky plan mode, `.omo/` artifacts |
| OMP model roles | `@role` aliases in agent frontmatter, `modelRoles` mapping, role provisioning at install | — (mechanism used as-is) |

Open items:

- **VitePress rendering of `docs/spec/**`:** this repo's `docs/` is a VitePress site (`docs/.vitepress/` present [CONFIRMED — repo tree]); spec drafts written under `docs/spec/` may render as site pages. Check `.vitepress/config` during implementation; adjust the site config if needed (ask-first boundary per SPEC.md). [INFERRED — rendering behavior of `docs/spec/**` not yet checked]
- **CLI record-subkey + project-scope probes** (§5.6) — resolved during installer implementation.
- **Live unset-role runtime verification** (§5.4) — one spawn test at implementation time; result appended to this doc.
- **Possible future:** implemented-spec archive/close-out (no such step exists today — §2).

---

## Sources

CONFIRMED-source count: **13 distinct sources** (each cited with at least one CONFIRMED claim above; primary sources fetched 2026-09-06).

1. `agent://RoleConfigScout` — research artifact (OMP settings/model-role fallback semantics; cites can1357/oh-my-pi@main `src/config/model-resolver.ts`, `model-roles.ts`, settings d.ts, extensions types, docs/settings.md, docs/extensions.md, docs/plugin-manager-installer-plumbing.md).
2. `agent://LocalHarnessScout` — research artifact (local omp 18.1.11 types `dist/types/**`, `~/.omp/agent/config.yml`, bundled agents, ExtensionAPI).
3. `agent://WebDocsScout` — research artifact (omp.sh sitemap/docs discovery, PR #2338, OpenCode/OpenSpec contrast).
4. github.com/Fission-AI/openspec — `README.md` @ main (workflow, artifact layout, scenario style, stores, 30+ tools, CLI dep).
5. github.com/Fission-AI/openspec — `docs/explore.md` @ main.
6. github.com/Fission-AI/openspec — `docs/how-commands-work.md` @ main (core/expanded command sets, per-tool syntax incl. Oh My Pi row).
7. dataleadsfuture.com — "Reflection SDD: Use a Reflection Harness to Level Up Your OpenSpec Workflow" (Peng Qian).
8. github.com/code-yeongyu/oh-my-openagent — `dev/packages/shared-skills/skills/ulw-plan/SKILL.md`.
9. github.com/can1357/oh-my-pi — `docs/task-agent-discovery.md` @ main (agent frontmatter `model:`, role-backed agents, dispatch semantics).
10. github.com/can1357/oh-my-pi — `docs/settings.md` @ main (settings scopes, precedence, `omp config` CLI, write paths).
11. `/Users/nntoan/.omp/agent/config.yml` — local modelRoles worked example (lines 78–87, 94–113).
12. Live probe: `omp config set --help` and `omp config get modelRoles --json` (2026-09-06).
13. Repo `SPEC.md` — this spec draft (adopted decisions, success criteria, open questions) at repo root (untracked draft).
