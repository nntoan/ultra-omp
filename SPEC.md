# Spec: Agent-Skills SDLC Workflow Hardening (explore-first, spec layout, reflection gate)

Status: draft (awaiting human approval)

## Objective

Improve the `@ultra-omp/agent-skills` package so its spec-driven lifecycle produces higher-quality inputs and organized artifacts, informed by ulw-plan (explore-before-ask), OpenSpec (Fission-AI), and the reflection-SDD pattern (Data Leads Future).

Target users: engineers running OMP with this plugin. The change makes `/spec` research the repository before questioning, files every spec under `docs/spec/<feature>/SPEC.md`, and inserts a user-gated reflection review between the spec draft and its approval — optionally executed on a different model via OMP model roles.

Four interlocking changes:

1. **Explore-before-ask.** When `spec-driven-development` is invoked, the harness first explores the repo (structure, existing code/patterns/specs, conventions, git state) and only asks clarifying questions that exploration cannot answer. Modeled on ulw-plan's two filters: evidence-answerable facts are researched, never asked; preferences/tradeoffs are asked only when no defensible default exists; owner-decisions (irreversible, cross-cutting, user-config surface) always surface as questions.
2. **Canonical spec layout.** `/spec` writes specs to `docs/spec/<feature>/SPEC.md` (one folder per feature). A multi-module capability map lives at `docs/spec/<initiative>/SPEC.md` with module specs at `docs/spec/<initiative>/<module>/SPEC.md`. All downstream readers in the SDL chain look in the new location first, then fall back to legacy locations (root `SPEC.md`, `docs/SPEC.md`, `spec/*`) during transition, offering to migrate when a legacy spec is found.
3. **Reflection gate before approval.** After the spec draft is finalized and saved, the agent must ask the user: approve the spec, or send it to the `spec-reflector` reviewer first. `spec-reflector` is a new read-only persona (new skill `spec-reflection` + new agent `agents/spec-reflector.md`) that reviews the draft for substantive defects (missed scenarios, contradictions, untestable success criteria, boundary gaps) and reports 🔴 Blocking / 🟡 Should Fix / 💡 Suggestion findings. The main session reconciles findings into the draft and re-asks. After two non-converging reflection rounds the agent must say so explicitly and let the user decide (ship as-is / manual edit / third opinion).
4. **Cross-model reflection via OMP model roles.** `agents/spec-reflector.md` declares `model: "@spec-reflector"` in frontmatter. The user maps that role to any provider/model in `modelRoles` (global or project config, or `/model` Roles view), enabling a different-LLM reviewer than the authoring agent. Findings from OMP model-role research are recorded in `docs/research/openspec-spec-reflection.md`.
5. **Install-time role provisioning.** Because OMP resolves an unset custom role to a literal selector that matches no model (no graceful fallback — only built-ins `smol`/`slow` inherit default), `@spec-reflector` must exist in `modelRoles` for the agent to spawn. The `ultra-omp` installer therefore provisions the role when installing `agent-skills`: set-if-absent, idempotent, never overriding an existing value, global scope by default and project scope under `--local`. It provisions only the single role key via `omp config set` — never the user's whole config.

The spec for this change is saved at repo root `SPEC.md` per the current `/spec` default (decision: this-spec location = repo root); future specs written by the tweaked `/spec` will use `docs/spec/<feature>/SPEC.md`.

### Decision log (confirmed with the user)

| Decision | Choice |
|---|---|
| Scope | Full SDL chain — fork touched files from upstream; untouched files stay byte-identical |
| Spec layout | `docs/spec/<feature>/SPEC.md`; multi-module nested under the initiative folder |
| Legacy specs | New-first lookup, legacy fallback, offer migration (no auto-migrate) |
| Reflection gate | Always ask after draft: approve vs reflect; agent recommends reflect for non-trivial specs |
| Cross-model | Custom role alias `@spec-reflector` on a new agent; user maps the role in `modelRoles` |
| Research doc | `docs/research/openspec-spec-reflection.md` (repo root, outside the package) |
| Role provisioning | Installer (ultra-omp) bakes `modelRoles.spec-reflector` set-if-absent after installing agent-skills; global default, project under `--local`; existing values never overridden; personal config not copied wholesale |
| This spec | Repo root `SPEC.md` |

### Success criteria (testable)

- [ ] `spec-driven-development/SKILL.md` Phase 1 opens with mandatory exploration before any clarifying question; question filters are explicit (evidence-answerable → research; defensible default → adopt + state; owner-decision → ask).
- [ ] `/spec` (commands/spec.md) writes drafts to `docs/spec/<feature>/SPEC.md` and confirms with the user; capability maps + module specs use the nested layout.
- [ ] Downstream readers locate specs new-first with legacy fallback: `/to-plan` (commands/to-plan.md), `planning-and-task-breakdown`, `/build` (commands/build.md spec whitelist + baseline allowlist). Legacy-located specs trigger an offer-to-migrate note.
- [ ] New `skills/spec-reflection/SKILL.md` and `agents/spec-reflector.md` exist; persona frontmatter includes `model: "@spec-reflector"`.
- [ ] `spec-driven-development` presents the approve-vs-reflect question after finalizing every draft; reflection results are reconciled before re-asking; two-round non-convergence is surfaced.
- [ ] `docs/research/openspec-spec-reflection.md` exists and records: OpenSpec capabilities vs our SDLC, reflection-SDD findings, ulw-plan explore-before-ask mechanics, OMP model-role mechanism with config snippets (built-in roles, `@` aliases, `modelRoles`, agent frontmatter `model:`), and the unset-role fallback verification step.
- [ ] Running the installer for `agent-skills` (global and `--local`) results in `modelRoles.spec-reflector` present in the target config; re-running is a no-op; a pre-existing user-set `spec-reflector` value is preserved untouched. Verified via `omp config get modelRoles --json` before/after.
- [ ] Package gates pass: `bun test test` (2/2), `bun test ./scripts/lib/skill-lint-test.js` (8/8), `bun scripts/validate-skills.js` (25+ skills, 0 errors — new skill included).
- [ ] Untouched files remain byte-identical to upstream addyosmani/agent-skills (verified by `diff -rq` against the pinned upstream tree for all non-forked files).

## Tech Stack

- No new runtime dependencies. No OpenSpec CLI adoption (research conclusion: our folder convention + skills cover the same ground without a dependency).
- OMP (Oh My Pi) harness facilities used: task agents from the package `agents/` dir, agent frontmatter `model:` role alias, `modelRoles` user config (global or project), `/model` Roles UI, `omp config set/get` CLI for provisioning.
- Installer provisioning uses the existing `omp config set` command — no YAML parsing library needed in `packages/installer`.
- Existing package tooling: bun, `scripts/validate-skills.js`, `scripts/lib/skill-lint.js`, `bun:test` (test/), `node --test` (installer tests).

## Commands

```text
# Package gates (must stay green)
cd packages/agent-skills
bun test test
bun test ./scripts/lib/skill-lint-test.js
bun scripts/validate-skills.js

# Installer gates
cd packages/installer
node --test test/*.test.mjs

# Provisioning verification (after implementing installer step)
omp config get modelRoles --json        # before: no spec-reflector key (or pre-existing value)
bunx @nntoan/ultra-omp --only agent-skills --yes   # or --local for project scope
omp config get modelRoles --json        # after: spec-reflector present; pre-existing value unchanged
# re-run install → idempotent (no change, no duplicate)

# Parity gate for untouched files (run from repo root)
diff -rq <upstream-tree>/{agents,commands,skills,references} packages/agent-skills/{agents,commands,skills,references}
# -> must report IDENTICAL on the subset of files NOT forked by this change
```

## Project Structure

Files forked (modified from current upstream-identical content):

```text
packages/agent-skills/
├── commands/
│   ├── spec.md                          # write docs/spec/<feature>/SPEC.md; explore-before-ask
│   ├── to-plan.md                       # read spec new-first (docs/spec/**), legacy fallback
│   └── build.md                         # spec whitelist + baseline allowlist → new layout first
├── skills/
│   ├── spec-driven-development/SKILL.md # Phase 1 exploration + reflection-gate + layout
│   ├── planning-and-task-breakdown/SKILL.md  # spec lookup wording (new-first + fallback)
│   └── spec-reflection/SKILL.md         # NEW: read-only spec-draft review workflow
├── agents/
│   └── spec-reflector.md                # NEW: persona, model: "@spec-reflector"
├── README.md                            # /spec row + workflow + role setup note
└── test/
    └── command-catalog.test.ts          # unchanged (9 .md names unchanged); verify only
```

New repo-root files (outside the package):

```text
docs/research/
└── openspec-spec-reflection.md          # NEW: research + adoption write-up
```

Installer change (role provisioning):

```text
packages/installer/
├── src/installer.mjs                     # post-install provisioning for agent-skills record
├── test/installer.test.mjs               # tests for set-if-absent/idempotency/--dry-run
└── src/catalog.generated.mjs             # regenerated only if record shape changes (scripts/sync-installer-catalog.mjs)
```

Untouched (must remain byte-identical to upstream): `agents/code-reviewer.md`, `agents/security-auditor.md`, `agents/test-engineer.md`, `agents/web-performance-auditor.md`, all `commands/*` not listed above, all other `skills/*`, all `references/*`, `extensions/`, `scripts/`, `package.json`, `.gitattributes`, `LICENSE`.

## Code Style

- Forked markdown keeps upstream structure/sections; changes are additive or localized rewrites, never wholesale paraphrasing of retained sections.
- Skill anatomy per `scripts/lib/skill-lint.js` + upstream `docs/skill-anatomy.md` conventions: YAML frontmatter (`name`, `description`), overview/when-to-use, gated process steps, verification checklist, red flags. New `spec-reflection` must pass `validate-skills.js`.
- Persona format mirrors existing `agents/*.md`: frontmatter `name`, `description`, plus `model`; body = role contract + output format + severity taxonomy + read-only mandate.
- `modelRoles` configuration examples use YAML `modelRoles: <role>: <provider/model[:thinking-level]>`; role alias selector `@<role>`; never hardcode a provider/model into the agent file (user mapping owns the actual model).
- Commits: conventional (`fix(agent-skills):` / `feat(agent-skills):`), atomic per logical change (e.g., reflection artifacts vs layout chain vs research doc).

## Testing Strategy

- Existing suite is the gate: `bun test test` (extension + command catalog), `skill-lint-test.js`, `validate-skills.js`. New skill must lint clean; catalog names unchanged.
- No new unit tests for prose content (parity + lint are the meaningful guards); the reflection *workflow* is verified by running it once against this spec draft as the first real use.
- Reflection-role fallback behavior with an unset custom role is a live-harness unknown → one runtime verification step during implementation; result recorded in the research doc (pass/fail + observed fallback).
- Parity regression guard: after the change, `diff -rq` against upstream for the untouched subset; report per-directory identical/differing.

## Boundaries

Always do:
- Explore the repo before asking clarifying questions during any `/spec` run (structure, conventions, existing specs, git state); cite evidence for what was researched.
- Write specs to `docs/spec/<feature>/SPEC.md`; multi-module specs nest under the initiative folder.
- Read specs new-first (`docs/spec/**`) with legacy fallback (root `SPEC.md`, `docs/SPEC.md`, `spec/*`); when a legacy spec is used, note it and offer migration.
- Ask the approve-vs-reflect question after every finalized draft; run reflection read-only; reconcile 🔴/🟡 into the draft or record the user's explicit decline.
- Keep untouched files byte-identical to upstream; keep the package dependency-free.
- Record research and role-setup instructions in `docs/research/openspec-spec-reflection.md`.

Ask first:
- Forking any file beyond the list above (e.g., if the chain needs `incremental-implementation` or another skill touched, confirm before modifying).
- Creating or changing `modelRoles` entries in user/global config outside the installer's single set-if-absent `spec-reflector` key (documented and instructed; never hand-edited by workflows).
- Distributing any user-specific config (theme, provider order, memory backend, advisor flags, model pick) as an install template — declined: wholesale config bring-over conflicts with existing users' configs and binds them to the author's providers/preferences; only the role key is provisioned.
- Changing the legacy fallback policy to strict/auto-migrate later.
- Adding a dependency (openspec CLI or otherwise).
- Deleting or renaming upstream-derived files.

Never:
- Never ask questions whose answers repo exploration can provide (the ulw-plan failure mode we are fixing).
- Never run reflection against code diffs — code review stays with `code-reviewer`/`/review`; `spec-reflector` reviews spec drafts only.
- Never paraphrase or truncate content in files that remain upstream-derived; never hand-edit upstream files outside the fork list.
- Never hardcode a concrete provider/model into the agent definition — the `modelRoles` mapping owns model selection (the installer may seed a default value, never the agent file).
- Never auto-migrate or delete legacy specs without the user's confirmation.
- Never replace or overwrite a user's existing `modelRoles.spec-reflector` value; never rewrite the user's config wholesale from the package, workflow, or installer.

## Open Questions

- ~~Unset-role behavior~~ RESOLVED by source research (`model-resolver.ts`): an unset custom role does not fall back to default — the alias passes through as a literal selector matching no model. `@spec-reflector` must therefore be provisioned; the installer's set-if-absent step (global + `--local`) guarantees it. Default seeded value when no user value exists: `ULTRA_OMP_SPEC_REFLECTOR_MODEL` env override → existing `modelRoles.advisor` → `modelRoles.slow` → `modelRoles.default` (spawn-safe; true cross-model requires the user to point the role at a second provider — documented in the research doc).
- Whether `docs/spec/**` under the VitePress `docs/` site needs a VitePress ignore/route tweak so spec drafts do not render as site pages — check `.vitepress/config` during implementation; if needed, adjust site config (ask-first boundary).
- Whether `omp config set` exposes an explicit scope flag for project writes or needs `cwd`-scoped invocation under `--local` — resolve during implementation by probing `omp config set --help`; both paths converge on the same `.omp/config.yml` project file per docs.
