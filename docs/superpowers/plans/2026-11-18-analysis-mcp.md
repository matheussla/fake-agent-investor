# Analysis MCP Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a ready-to-connect, read-only MCP for complete trading evidence analysis.
**Architecture:** Standalone stdio server, curated PostgreSQL queries, read-only transactions, bounded results, and discoverable guidance.
**Tech Stack:** TypeScript, official MCP SDK, pg, Zod, Vitest.
**Spec:** ../specs/2026-11-18-analysis-mcp-design.md (approved).

## Global constraints

No automatic client setup, model calls, trading, or agent mutations. No arbitrary SQL/files/network tools. Preserve decimal strings and full evidence. Only the dashboard image appears in README.

## Review focus

- Equal timestamps must not skip records: paginate by unique ID and test traversal.
- Large evidence must remain accessible: chunk record JSON and test reconstruction.
- Deleted reports must require explicit opt-in: test lists and direct retrieval.
- Database errors must not reveal credentials: test sanitized protocol errors.
- Cross-filter cursors must fail clearly: bind cursors to query scope and test rejection.

## Task 1: Read-only data access

Files: apps/server/src/mcp/data.ts, tests/integration/mcp.integration.test.ts.
- [x] Write integration tests for pagination, filters, archives, decimals, deleted visibility, invalid inputs, missing IDs, and read-only enforcement; confirm initial failure.
- [x] Implement curated dataset catalog, strict query validation, scoped cursors, read-only transaction helper, record chunk retrieval, and portfolio/state snapshot.
- [x] Run focused integration tests.

## Task 2: MCP protocol and launch

Files: apps/server/src/mcp/server.ts, apps/server/src/mcp/index.ts, apps/server/src/mcp/server.test.ts, package manifests and lockfile.
- [x] Add official SDK dependency; register tools, guide/dictionary resources, and recommendation prompt.
- [x] Add stdio entry point, stderr-only diagnostics, bounded database connections, signal shutdown, and launch scripts.
- [x] Test SDK initialization/discovery, resource/prompt retrieval, tool calls, errors, and stdio shutdown.

## Task 3: Documentation and final verification

Files: docs/mcp.md, README.md, approved design and this plan.
- [x] Document launch/client examples, data dictionary, traversal/chunking, SELECT-only role setup, data visibility and limits.
- [x] Run unit/integration tests, lint, typecheck, build and real stdio handshake.
- [x] Review diff for read-only guarantees and unintended runtime imports; report results.

## Completion evidence

- 79 unit and 94 integration tests passed; typecheck, lint and build passed.
- Real stdio smoke verified discovery, resources, prompt and live database reads without model calls or mutations.
- Independent review identified date-bound precision and Unicode chunk boundaries; fixes have passing regression coverage. Dataset traversal also verified actual PostgreSQL column names.
- Implementation uses 19 curated datasets behind three tools. Complete records are retrieved as hash-checked chunks, preserving bounded responses.
- UUID pagination intentionally avoids timestamp precision gaps; pages are live reads, not a frozen export, as documented. No client was installed or connected persistently.
- Browser E2E was not rerun: no UI behavior changed.
