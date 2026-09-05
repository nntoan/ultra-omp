---
description: Run a web performance audit via the web-performance-auditor persona
---
Invoke `web-performance-auditor` through OMP's `task` tool for `$ARGUMENTS`.

## Determine the mode

Deep mode applies when any of these is available: a Lighthouse JSON report, PageSpeed Insights JSON, a CrUX response, a DevTools performance trace, a live URL with browser performance tooling, or output from the Chrome DevTools CLI. Pass the artifact paths or JSON, target URL/page, reviewed files or diff, and the expected mode to the persona. Never hard-code `$CRUX_API_KEY` or `$GOOGLE_API_KEY`; mark unavailable measurements `not measured`.

Quick mode is the fallback whenever no browser metrics or artifacts are available. It is valid for server-only projects and utility code: scan source and configuration for structural performance anti-patterns, label every finding `potential impact`, and delegate only to `web-performance-auditor`. Do not refuse Quick mode because the project has no browser-facing output; state that browser metrics are not measured.

## Run and return the audit

The auditor returns a sourced scorecard, ranked findings, positive observations, and proactive recommendations. In Deep mode, identify every artifact used and every field left unmeasured. In Quick mode, distinguish static risks from measured results. Return the full audit report without a synthesis or merge step; this command uses one persona only.
