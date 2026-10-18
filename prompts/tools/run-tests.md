## Run Tests Tool

Run project tests through their existing package scripts. Node, Vitest and Jest executions can produce bound per-file completion evidence for `deliver_task`.

- `files`: exact repository-relative test paths, including workspace packages. Mutually exclusive with `filter`.
- `filter`: a test filename, stem or path, matching `.test` and `.spec`. Ambiguous names return candidates; no automatic first match.
- No selector: retain the original full project entry.
- `timeout`: total budget in milliseconds (default 120000), shared by batches, isolated/integration phases and attribution retries.

Package scripts, hooks, environment arguments, configuration, loader and setup remain authoritative. Only installed dependencies are used. Unsupported or ambiguous entries return a reason and retain delivery obligations. Name/tag/line filters, focus, zero tests, skipped files and incomplete or stale reports cannot prove whole-file execution.

Use `run_tests(files=["packages/web/src/a.spec.ts"])` for a precise batch. `deliver_task` returns a machine-readable `verificationPlan` and remaining batches; it does not start tests. Use its suggested `run_tests(files=[…])` calls, then invoke delivery again. `force` does not waive coverage or ownership checks.

Other languages retain their declared commands and result handling. Native bun tests and Playwright/Cypress/Mocha are outside automatic completion proof support.
