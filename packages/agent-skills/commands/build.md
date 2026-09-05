---
description: Implement planned tasks incrementally with tests, builds, and commits
---
Invoke `incremental-implementation` alongside `test-driven-development` for `$ARGUMENTS`.

Default `/build` selects the next pending task, reads acceptance criteria and context, writes a failing behavior test, implements the minimum change, runs regressions and the build, commits the task, marks it complete, and stops. `/build auto` and `/build all` require a known spec and plan, a clean baseline apart from planning artifacts, one explicit approval, and then execute every task in dependency order. Preserve RED → GREEN → regression → build → commit for each task and stage only that task's files. Stop for ambiguity, high-risk irreversible changes, or failures without an obvious fix.
