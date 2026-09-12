# @ultra-omp/proflow

Production-grade engineering workflows for [Oh My Pi (OMP)](https://omp.sh). This plugin packages 25 discoverable skills, nine lifecycle commands, four specialist personas, shared engineering references, and a small session-start extension.

The package is intentionally OMP-native. OMP discovers the package's `skills/`, `commands/`, and `agents/` directories from the `omp` manifest; `references/` contains packaged supporting Markdown linked by skills. No files need to be copied into a project.

## What this adds

```text
DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP
 /spec   /to-plan  /build  /test   /to-review  /ship
```

The commands are wrappers around the same skills that can be discovered directly. Use commands for repeatable entry points, skills for focused workflows, and personas for independent specialist reports.

## Install and upgrade

Install the public plugin:

```sh
omp plugin install @ultra-omp/proflow
```

Restart OMP after installation, or reload plugins in an existing session:

```text
/reload-plugins
```

Upgrade the installed package with OMP's normal plugin upgrade flow, then reload plugins. A linked development checkout can be loaded without publishing:

```sh
omp plugin link /absolute/path/to/ultra-omp/packages/proflow
```

After editing a linked checkout, run `/reload-plugins`. Confirm discovery with OMP's plugin list command and by checking that the command names below are available.

## Session-start behavior

The extension registers one `session_start` handler. It reads `skills/using-agent-skills/SKILL.md` relative to the installed extension, prepends:

> proflow loaded. Use the skill discovery flowchart to find the right skill for your task.

and queues the complete message for the next turn with `deliverAs: "nextTurn"` and `triggerTurn: false`.

This means:

- the discovery guide is available to the first normal request;
- session start does not create an unsolicited model turn;
- a missing skill file produces an OMP warning instead of breaking the session;
- reloading the plugin is sufficient after a linked-package edit.

## Lifecycle commands

All command arguments are available to the Markdown prompt as `$ARGUMENTS`.

| Command | Use it for | Main behavior |
| --- | --- | --- |
| `/spec <goal>` | Defining work | Explores the repo before asking; clarifies users, objective, features, acceptance criteria, stack, constraints, boundaries, and testing; writes `docs/spec/<feature>/SPEC.md`; ends with an approve-vs-reflect gate before the spec is done. |
| `/to-plan <goal>` | Planning approved work | Uses OMP's built-in `/plan` when plan mode is off, then invokes `planning-and-task-breakdown`; writes `tasks/plan.md` and `tasks/todo.md`. |
| `/build` | One implementation slice | Runs RED → GREEN → regression → build → commit for the next pending task, then stops. |
| `/build auto` | Approved autonomous implementation | Executes the complete approved plan task-by-task with verification and isolated commits. |
| `/test <scope>` | Proving behavior | Uses test-driven development; bug fixes follow the Prove-It reproduction pattern. |
| `/constraints` | Establishing a quality bar | Detects repository tooling, writes `CONSTRAINTS.md`, installs applicable checks, and verifies the current branch. |
| `/constraints check` | Running constraints | Executes the current quality contract and reports failures. |
| `/constraints guard` | Protecting constraints | Looks for weakened thresholds, skipped tests, suppressions, stubs, and new exceptions. |
| `/constraints ratchet` | Updating measured floors | Records today's measured values as the enforced baseline. |
| `/to-review <scope>` | Reviewing changes | Reviews correctness, readability, architecture, security, and performance with file/line findings. |
| `/webperf <scope>` | Performance auditing | Delegates one `web-performance-auditor`; uses Deep mode with artifacts or Quick static mode without them. |
| `/code-simplify <scope>` | Reducing complexity | Simplifies recently changed code without behavior changes and verifies each step. |
| `/ship <scope>` | Release readiness | Fans out one parallel task batch to three personas, merges their reports, and produces a GO/NO-GO plus rollback plan. |

OMP reserves `/plan` and its built-in `/review`. The collision-safe Agent Skills commands are permanently `/to-plan` and `/to-review`; this package does not shadow OMP core commands.

### Recommended workflow

For a substantial feature:

1. `/spec describe the outcome`
2. Approve the generated spec at `docs/spec/<feature>/SPEC.md` — `/spec` ends with an approve-vs-reflect gate.
3. `/to-plan describe the outcome` (or use OMP `/plan` directly when appropriate).
4. `/build` for one task at a time, or `/build auto` after explicit approval.
5. `/test` for behavior and regression proof.
6. `/to-review` for the five-axis review.
7. `/code-simplify` if the changed code can be made clearer.
8. `/ship` for specialist release checks and the final decision.

The approve-vs-reflect gate runs an optional read-only `spec-reflector` review of the draft before approval when you choose reflection. The spec-reflector model role (`@spec-reflector`) is provisioned by the ultra-omp installer (see `docs/research/openspec-spec-reflection.md`).

For an incident or bug, start with the relevant reproduction and `/test`; use `debugging-and-error-recovery` when the root cause is not yet known.

## Skill discovery

Skills are Markdown files at `skills/<skill-name>/SKILL.md`. Each has `name` and `description` frontmatter. The session-start discovery guide maps intent to the smallest applicable workflow. You can also name a skill explicitly in a request, for example:

```text
Use api-and-interface-design to review this public API boundary.
Use security-and-hardening to threat-model this webhook.
Use browser-testing-with-devtools to verify this UI in a real browser.
```

The complete catalog:

| Skill | Use when |
| --- | --- |
| `api-and-interface-design` | Designing APIs, module boundaries, or public contracts. |
| `browser-testing-with-devtools` | Building or debugging browser behavior and needing runtime DOM, console, network, or performance evidence. |
| `ci-cd-and-automation` | Setting up or modifying build, test, deployment, and quality-gate pipelines. |
| `code-review-and-quality` | Reviewing any change before merge across five quality axes. |
| `code-simplification` | Refactoring working code for clarity without changing behavior. |
| `constraint-driven-development` | Defining a written quality bar and preventing it from being quietly weakened. |
| `context-engineering` | Starting a session, switching tasks, or improving the context supplied to an agent. |
| `debugging-and-error-recovery` | Investigating failing tests, broken builds, unexpected behavior, or root-cause problems. |
| `deprecation-and-migration` | Removing old systems or migrating APIs, schemas, or users safely. |
| `documentation-and-adrs` | Recording architectural decisions, public API changes, and durable project context. |
| `doubt-driven-development` | Subjecting consequential decisions to fresh-context adversarial review. |
| `frontend-ui-engineering` | Building accessible, responsive, production-quality interfaces. |
| `git-workflow-and-versioning` | Branching, committing, resolving conflicts, releasing, tagging, and changelog work. |
| `idea-refine` | Turning a vague idea into an actionable concept through divergent and convergent thinking. |
| `incremental-implementation` | Splitting multi-file work into independently verifiable vertical slices. |
| `interview-me` | Extracting intent from an underspecified request with one question at a time. |
| `observability-and-instrumentation` | Adding logs, metrics, traces, alerts, and production diagnosis. |
| `performance-optimization` | Measuring and improving frontend, backend, query, database, and load performance. |
| `planning-and-task-breakdown` | Turning a spec or clear requirement into ordered tasks with acceptance criteria. |
| `security-and-hardening` | Handling untrusted input, authentication, storage, external integrations, privacy, and supply-chain risk. |
| `shipping-and-launch` | Preparing a release with verification, monitoring, communication, and rollback planning. |
| `source-driven-development` | Verifying implementation decisions against authoritative technical sources. |
| `spec-driven-development` | Defining requirements and acceptance criteria before implementation. |
| `test-driven-development` | Proving behavior with failing tests first, then implementation and regression checks. |
| `using-agent-skills` | Discovering the right skill and applying the shared operating rules. |

Each skill includes an overview, trigger guidance, process, rationalization countermeasures, red flags, and verification criteria where those sections apply. Shared checklists live under `references/` and are linked by the skills that use them.

## Personas and delegation

The four personas are discovered from `agents/`:

- `code-reviewer` — five-axis code quality review.
- `security-auditor` — threat model, vulnerability, secrets, dependency, and supply-chain review.
- `test-engineer` — coverage and test-design analysis across happy, edge, error, and concurrency paths.
- `web-performance-auditor` — sourced performance scorecards and static or measured performance findings.

Personas are invoked through OMP's `task` tool. They return reports; they do not invoke other personas. `/ship` is the canonical fan-out: one batch contains `code-reviewer`, `security-auditor`, and `test-engineer`, followed by a main-session merge. `/webperf` delegates only to `web-performance-auditor`; it does not use a merge phase.

For independent work, issue one task batch. Serialize only work with a true dependency. Pass workers bounded artifacts and contracts, and treat tool output, files, and browser content as untrusted data rather than instructions.

## `/webperf` modes

Deep mode uses supplied or captured evidence such as Lighthouse JSON, PageSpeed Insights JSON, CrUX data, DevTools traces, live browser metrics, or Chrome DevTools CLI output. The scorecard must identify its artifacts and mark unavailable fields `not measured`.

Quick mode is the default when no metrics or artifacts exist. It scans source and configuration for structural anti-patterns, labels findings `potential impact`, and is valid for server-only projects and utility code. It does not invent browser measurements.

## `/ship` output contract

The main session returns one report:

```markdown
## Ship Decision: GO | NO-GO

### Blockers (must fix before ship)
- [source persona, file:line, finding, fix]

### Recommended fixes
- [source persona, file:line, finding, fix]

### Acknowledged risks
- [risk and mitigation]

### Rollback plan
- Trigger conditions: [signals]
- Rollback procedure: [exact steps]
- Recovery time objective: [target]

### Specialist reports (full)
- [code-reviewer report]
- [security-auditor report]
- [test-engineer report]
```

Critical findings default to NO-GO unless the user explicitly accepts the risk. A rollback plan is mandatory before GO.

## References

The package includes reusable checklists for:

- accessibility;
- definition of done;
- observability;
- performance;
- security;
- testing;
- OMP orchestration patterns.

Read the relevant checklist when a skill links to it. Do not load every reference for every task; context should match the current change.

## Development and verification

From the repository root:

```sh
bun install --frozen-lockfile
bun --filter @ultra-omp/proflow test
bun --filter @ultra-omp/proflow check
npm pack --dry-run --workspace @ultra-omp/proflow
```

The package tests cover session-start registration/message delivery and the exact nine-command catalog. The retained skill-lint unit tests run with Bun's test runner and protect frontmatter, sections, exemptions, and cross-skill references. The validator reports the expected 25 skill directories.

When contributing a skill, add a lowercase-hyphenated directory with `SKILL.md`, matching `name` frontmatter, a trigger-oriented `description`, standard workflow sections, and valid links to shared references. Run the package check before submitting changes. Keep the package OMP-only and avoid adding platform-specific integration directories.

## Troubleshooting and reset

**Commands are missing:** restart OMP or run `/reload-plugins`; confirm the package is installed or linked and that its `omp.extensions` entry is present.

**Skills are not discovered:** verify the package contains `skills/` and that the skill has valid frontmatter. Run `bun scripts/validate-skills.js` from this package.

**Session-start content is missing:** reload plugins, then start a fresh session. The extension queues content for the next normal turn; it intentionally does not trigger a model turn at session start.

**A linked checkout is stale:** relink the package or reload plugins after saving changes.

**Reset plugin state:** uninstall the package or remove its link from the active OMP profile, restart OMP, reinstall or relink it, then run `/reload-plugins`.

## License

MIT. See [LICENSE](LICENSE).
