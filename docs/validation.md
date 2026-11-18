# System validation

Run validation from the repository root. Integration tests use the isolated `paper_investor_test` PostgreSQL database on port 5433; they truncate its tables between cases.

```sh
pnpm db:up
pnpm db:migrate:test
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

The PostgreSQL suite covers accounting and immutable ledger behavior, risk limits, idempotent and concurrent execution, cancellation and reset races, restart recovery, daily allowance rollovers, prompt and settings versioning, request-origin validation, and secret redaction. The browser suite exercises desktop and Pixel 7 layouts, provider readiness, prompt activation, settings, lifecycle controls, loss-pause feedback, and archived simulation history.

## External smoke checks

Live exchange and model checks are separate from automated tests. They use public market data or one bounded decision request and do not submit orders. Run them only after configuring the relevant service credentials; commands and expected results are documented in the repository README.

The Codex adapter uses the OpenAI Responses API without tools. Automated tests mock the HTTP boundary and verify structured decisions, usage, cancellation, missing credentials, error redaction, and the daily allowance. `pnpm smoke:codex` sends one bounded request with synthetic data using `OPENAI_API_KEY`, validates a hold decision, and discards it without submitting an order. No Codex CLI configuration is read or modified.
