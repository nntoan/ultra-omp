---
description: Define and enforce this project's quality bar in CONSTRAINTS.md
---
Invoke `constraint-driven-development` for `$ARGUMENTS`. With no arguments, detect package metadata, test runner, lint configuration, current coverage, CI, OMP configuration, and `AGENTS.md`; report findings in two lines and ask at most four questions, each with a best guess and usable default. Write root `CONSTRAINTS.md` with a Floor section, enforced numbers, measured-only metrics, reasons for every number, and owner/expiry exceptions. Install the de facto tool for each selected dimension, record exact commands, place fast checks in the edit loop and expensive checks in review/CI, and point `AGENTS.md` at the constraints. Verify against the current branch.

Subcommands: `/constraints check` runs the constraints; `/constraints guard` detects weakened thresholds, skipped/deleted tests, suppressions, stubs, or new exceptions; `/constraints ratchet` records today's measured values as the floor.
