---
description: Simplify changed code for clarity without changing behavior
---
Invoke `code-simplification` for `$ARGUMENTS`. Read `AGENTS.md` and project conventions, identify callers, edge cases, and test coverage, then simplify incrementally: use guard clauses, split responsibilities, improve names, deduplicate logic, and remove confirmed dead code. Run focused tests after each change, preserve error handling, verify the build and full tests, and finish with `code-review-and-quality`. Revert a simplification that breaks behavior.
