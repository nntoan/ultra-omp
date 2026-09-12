---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---
Invoke the planning-and-task-breakdown skill.

Find the existing spec new-first: search `docs/spec/**` (`docs/spec/<feature>/SPEC.md`, nested module specs). Fall back to the legacy locations only if none is there — SPEC.md at the repo root, docs/SPEC.md, or a file under spec/. When the spec you use lives at a legacy location, note it and offer to migrate it to `docs/spec/<feature>/SPEC.md` (no auto-migration). Read the spec and the relevant codebase sections. Then:

1. Enter plan mode — read only, no code changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Present the plan for human review

Save the plan to tasks/plan.md and task list to tasks/todo.md.
