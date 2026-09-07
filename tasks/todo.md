# Todo — `@ultra-omp/pi-deepseek-statusline`

Task checklist mirroring [`tasks/plan.md`](./plan.md) (acceptance criteria, verification commands, dependencies, file lists, and risks live there — open it before starting a task). Check items off as they pass their gates.

## Phase 1: Foundation

- [x] Task 0: Run full-suite baseline (`bun install`; `bun test`; record pass/fail names to `local://baseline.md`) — no repo files
- [x] Task 1: Scaffold package + workspace + installer catalog (package mirror, root `workspaces`, `sync:installer-catalog`; smoke test green)
- [x] Task 2: Verify runtime anchors (usage output key, subagent session linkage, `modelRegistry` key accessor) → README Implementation notes
- [x] Checkpoint A: Foundation reviewed by human

## Phase 2: Pure engines

- [x] Task 3: Config primitives — `lib/config.ts` (defaults, flat YAML read/write, atomic) + tests
- [x] Task 4: Window engine — `lib/window.ts` (phaseAt, localClock, formatCountdown) + matrix/DST tests
- [x] Task 5: Pricing engine — `lib/pricing.ts` + live fixtures (en/zh-cn) + fetch-once/force-refresh tests
- [x] Checkpoint B: Engines green; fixtures reflect live pages
- [x] Task 6: Ledgers + session cost — `lib/usage.ts`, `lib/cost.ts` + exact-sum tests
- [x] Task 7: Balance + display-currency rule — `lib/balance.ts` + keyless/cadence/currency tests
- [x] Task 8: Visibility predicate — `lib/active.ts` + transition tests
- [x] Checkpoint C: Aggregation engines reviewed by human

## Phase 3: Integration

- [x] Task 9: Status-line controller + entry wiring — `lib/statusline.ts`, `extensions/index.ts` + mocked-ctx tests
- [x] Checkpoint D: Live line demoed in app; human review (demo ran inside the Task 12 E2E — see local://e2e-report.md)

## Phase 4: Configuration, docs, final verification

- [x] Task 10: `/ds-statusline` command + `--force-refresh` (askDialog + fallbacks; atomic YAML persist; tests)
- [x] Task 11: Finalize README + Implementation notes
- [x] Checkpoint E: Config + docs reviewed by human
- [x] Task 12: Full verification + in-app E2E (suite vs baseline; E2E checklist — see local://e2e-report.md)
- [ ] Checkpoint F: All SPEC Success Criteria 1–8 met; final approval

Legend: `- [ ]` = pending, `- [x]` = gate passed / review done (checkpoints become `[x]` only after human review).
