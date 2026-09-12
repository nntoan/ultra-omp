---
description: Start spec-driven development — write a structured specification before writing code
---
Invoke the spec-driven-development skill.

Explore before asking. Before any clarifying question, explore the repository: structure, existing code and conventions, git state, and any existing specs — look under docs/spec/** first, then the legacy locations (SPEC.md at the repo root, docs/SPEC.md, or a file under spec/). State what you explored. Ask only what exploration cannot answer: research evidence-answerable facts, adopt and state defensible defaults for preferences and tradeoffs, and surface owner-decisions (irreversible, cross-cutting, or user-facing) as questions.

Then clarify the objective and target users, core features and acceptance criteria, tech stack preferences and constraints, and known boundaries (what to always do, ask first about, and never do).

Then generate a structured spec covering all six core areas: objective, commands, project structure, code style, testing strategy, and boundaries. Save the draft to docs/spec/<feature>/SPEC.md — choose or create a kebab-case feature id and create the docs/spec/ tree if it does not exist. If the request bundles several independently testable capabilities, first propose a capability map (module ids, dependency direction, build order) per the skill's Phase 0, save it to docs/spec/<feature>/SPEC.md, and get it approved; then spec each module in dependency order, nesting each module spec at docs/spec/<feature>/<module>/SPEC.md.

When the draft is finalized and saved, run the approve-vs-reflect gate before the spec is done: ask the user — approve the spec as-is, or send it to spec-reflector for a read-only review first? If they choose reflection, dispatch spec-reflector per the spec-reflection skill and reconcile its findings into the draft before re-asking. Do not consider the spec done until the user has answered the gate.
