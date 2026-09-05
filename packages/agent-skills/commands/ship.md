---
description: Run the pre-launch checklist via parallel specialist personas and synthesize a go or no-go decision
---
Invoke `shipping-and-launch` for `$ARGUMENTS`.

`/ship` is a flat fan-out orchestrator. Run one OMP `task` batch containing these three independent workers concurrently:

1. `code-reviewer`: review staged or recent changes across correctness, readability, architecture, security, and performance.
2. `security-auditor`: perform OWASP Top 10, threat-model, secrets, auth/authz, dependency-CVE, and supply-chain checks.
3. `test-engineer`: analyze happy-path, boundary, error-path, regression, and concurrency coverage.

Pass each worker the current diff, relevant spec, and verification output. Workers return reports only and must not invoke other personas. If task workers are unavailable, run the three persona prompts sequentially in the main session but preserve the same three-report merge contract.

After all reports return, the main session—not a persona—merges them. Deduplicate findings and inspect infrastructure, accessibility, documentation, migrations, monitoring, and feature flags directly. Categorize blockers as Critical, recommended work as Important, and optional risk as Suggestion. Any Critical finding defaults to NO-GO unless the user explicitly accepts it.

Return exactly one report with:

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

Skip fan-out only when the change touches two files or fewer, is under 50 lines, and does not touch auth, payments, data access, or configuration. A rollback plan remains mandatory for every GO decision.
