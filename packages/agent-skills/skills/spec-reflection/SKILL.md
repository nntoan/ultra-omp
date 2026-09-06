---
name: spec-reflection
description: Read-only critical review of spec drafts before they are approved. Use when a spec draft needs a pre-approval pass for missed scenarios, contradictions, untestable success criteria, or boundary gaps — invoked by /spec's approve-vs-reflect gate or as a user-requested second opinion.
---

# Spec Reflection

## Overview

This skill is the workflow behind the spec-reflector persona (`agents/spec-reflector.md`). Its job is an independent, read-only critique of a spec draft *before* the human approves it: find the missed scenarios, contradictions, untestable success criteria, and boundary gaps that would otherwise surface halfway through implementation as rework or incidents.

The reviewer never edits the spec. It reports findings with severities and lets the authoring session reconcile them into the draft. The review is cheap; the rework it prevents is not.

## When to Use

- The approve-vs-reflect gate in `spec-driven-development` asks the user whether to approve a finalized draft or reflect first, and the user chooses reflection.
- A user asks for a second opinion on a spec draft before approving it — same read-only pass, regardless of which command produced the draft.
- A spec spans several independently testable capabilities and needs its capability map and module specs checked as a whole.

**When NOT to use:** reviewing code (that stays with `code-reviewer`), reviewing an already-approved spec as a change request, or any situation where you would need to write to the repository. If the draft needs edits, report the finding — do not make the edit.

## The Review Contract

1. **READ-ONLY, always.** Never edit the spec, never create or modify files, never "fix" a finding yourself. Output is a report. Verify at the end that the review changed nothing.
2. **Review against the actual repository, not in a vacuum.** Read the real code the spec describes, the repo's existing conventions, and the repository state the spec assumes. A finding about a missing convention, an unreachable command, or a contradictory boundary must be grounded in what the repo actually shows. In a vacuum, every draft looks reasonable.
3. **Context-aware versus existing specs.** Read the specs already in the repository — `docs/spec/**` first, then legacy locations (`SPEC.md` at the repo root, `docs/SPEC.md`, `spec/*`). The draft must not contradict them or silently duplicate another feature's scope; if it does, that is a finding.
4. **Every finding earns its severity with a "why it causes rework" rationale.** State the consequence: which later phase pays, and what the failure looks like (re-implemented slice, contradicting PRs, untestable acceptance, scope bleed).
5. **Severity over volume.** One 🔴 with a concrete consequence beats ten 💡 nits. Prefer the few findings that change the outcome of implementation.

## Severity Taxonomy

- **🔴 Blocking** — the draft cannot be approved as-is. Examples: a missed scenario that invalidates a success criterion, a contradiction between sections or with an existing spec, an untestable or unmeasurable success criterion, an undefined boundary on something the spec itself marks Ask-first, a capability map whose modules cannot be built in the stated order. Must say why approving it now forces rework or an incident later.
- **🟡 Should Fix** — likely to cause rework or a wrong slice if left. Examples: an under-specified acceptance criterion, an ambiguity between two plausible readings of scope, a boundary gap on a path the spec explicitly names. Fix before approval when cheap; if skipped, the author should consciously accept the risk.
- **💡 Suggestion** — optional improvement with no rework if skipped. Examples: a clearer way to phrase a criterion, a tighter example, a structural nicety. Never block on these.

## Review Checklist

- [ ] **Six core areas complete** — objective, commands, project structure, code style, testing strategy, and boundaries are all present and concrete, not stubs.
- [ ] **Success criteria are specific and testable** — each criterion is an observable condition with a measurable bar or a command that demonstrates it; none read as vibes ("fast", "clean", "done right").
- [ ] **Boundaries are defined** — Always / Ask / Never tiers exist and cover the operations the spec's own commands and structure imply.
- [ ] **No missed scenarios** — error paths, empty states, existing-data migration, permissions, and the failure modes of the spec's own commands are covered or explicitly deferred.
- [ ] **No contradictions** — between sections of the draft, and between the draft and existing specs in `docs/spec/**` (or legacy locations).
- [ ] **Capability map present when multi-module** — a spec spanning several independently testable capabilities has an approved map (module ids, dependency direction, build order) and every module spec traces to a map id.
- [ ] **Location follows the docs/spec policy** — the draft is saved to `docs/spec/<feature>/SPEC.md`, with module specs nested at `docs/spec/<feature>/<module>/SPEC.md`, not at the repo root or in a one-off folder.

## Output Shape

Report findings against the saved draft, each with a file/section reference and the rework or incident it prevents:

```markdown
## Spec Reflection: <draft path>

**Verdict:** READY FOR APPROVAL | NEEDS REVISION
**Rationale:** [one sentence]

### Blocking
- [docs/spec/<feature>/SPEC.md, §Success Criteria] <finding> — <why approving now causes rework/incidents>

### Should Fix
- [docs/spec/<feature>/SPEC.md, §Boundaries] <finding> — <consequence if left>

### Suggestions
- [docs/spec/<feature>/SPEC.md, §Objective] <finding>

### Verified
- [ ] Reviewed against the actual repository (code, conventions, git state)
- [ ] Compared with existing specs (`docs/spec/**` first, then legacy)
- [ ] No files modified — this review is read-only
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Review the spec after implementation starts; the draft is close enough" | A draft that is merely close enough is exactly what produces mid-build surprises. Pre-approval is the only point where the fix costs minutes instead of rework. |
| "The author asked for reflection, so I should find something" | That is manufacturing defects to justify the pass. If the draft is sound, say READY FOR APPROVAL with the evidence checked. |
| "Nitpicking is thoroughness" | Nits drown the blocking findings. Severity is the signal; keep suggestions few and genuinely useful. |
| "I'll suggest the solution instead of the problem" | A finding must first establish the defect and its consequence. Jumping to a fix before the problem is acknowledged buries the defect under implementation detail. |
| "Existing specs don't matter for this new feature" | New specs share the repository. A draft that contradicts or duplicates an existing `docs/spec/**` spec produces conflicting PRs and scope bleed. |

## Red Flags

- Rubber-stamping: approving without reading the draft against the real repository
- Reviewing in a vacuum: findings with no grounding in the actual code, conventions, or existing specs
- Nitpicking over substance: many 💡, no 🔴/🟡, no rework rationale
- Jumping to solutions before the problem is acknowledged
- Ignoring existing specs in `docs/spec/**` (or legacy locations)
- Vague feedback with no file/section reference and no consequence
- Editing the spec, or writing any file, during the review

## Verification

Before submitting the reflection report, confirm:

- [ ] The report is read-only: no files were created, edited, or deleted (verify with `git status` if unsure)
- [ ] The draft was reviewed against the actual repository, not in a vacuum
- [ ] Existing specs were consulted — `docs/spec/**` first, then legacy locations
- [ ] Every 🔴 and 🟡 finding names its file/section and why it causes rework or an incident
- [ ] Success criteria, boundaries, missed scenarios, contradictions, and capability-map coverage were all checked
- [ ] The draft's location follows the docs/spec policy (`docs/spec/<feature>/SPEC.md`, nested module specs)
