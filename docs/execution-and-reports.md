# Execution and report reference

## Execution safety and latency


Paper fills retain a single PostgreSQL transaction for orders, fills, ledger movements, and positions. Trades, valuation, and daily-loss enforcement lock the simulation in the same order, preventing concurrent overspending, overselling, or mixed portfolio snapshots. Failed or cancelled transactions roll back. Once COMMIT has been sent, cancellation cannot undo a completed fill; retry the same request to discover its stored outcome.

Run Once retains its request ID in session storage until the server confirms it, including across navigation and reloads. Execution retries return the original filled or rejected order. Reusing a decision ID with a different side, symbol, quantity, generation, or configuration fails with an idempotency conflict.

Execution uses fresh in-memory Binance quotes when available, with indexed latest-sample lookups as a fallback. No market network requests run while a portfolio transaction holds its lock. Binance instrument metadata is cached for five minutes; concurrent callers share a ten-second bounded refresh without cancelling each other. Execution has a five-second cancellation deadline, database lock waits are capped at two seconds, and database statements and connection acquisition are bounded at five seconds. An in-flight statement may finish before cancellation is checked; cancellation is checked again before COMMIT.

Strategy settings include **Maximum decision age** (default 60 seconds, range 1–180) and **Maximum adverse price movement** (default 50 basis points, range 0–500). These are separate from simulated slippage. Old decisions and prices moving against the proposed trade are rejected and recorded. Favorable price movement still passes through all existing risk checks. Existing configurations receive the same defaults without rewriting their history.

Decision records include execution duration and decision age in milliseconds. The model-call allowance remains a strategy control; database optimizations do not shorten the AI deliberation cycle or guarantee profitable trades. Apply migration `0006_quote_symbol_received` with the normal migration command before benchmarking quote history lookups.

## Saved trading reports


Every terminal trading evaluation (including HOLD, failure, and rejection) is saved as a versioned JSON `decision_report` in PostgreSQL `operational_events`. Startup and a 30-second recovery job backfill missing reports in batches of 100. Report-write failures are logged and retried without changing a completed trade. Back up PostgreSQL to retain these reports outside this machine.

The **Reports** tab downloads recent reports. Local same-origin APIs:
- `GET /api/reports?simulationId=<uuid>&limit=20&before=<ISO timestamp>` lists saved reports (maximum 100 per page).
- `GET /api/reports/<report UUID>` downloads the complete JSON evidence.
- `GET /api/trading-sessions?simulationId=<uuid>` retrieves persisted session start/stop events.

Schema version 1 retains the decision input snapshot, configuration, team snapshot (including versioned prompts), individual turns/messages, orders, fills, and ledger entries. Money remains decimal strings. Metrics include filled/rejected counts, fees, turnover, realized sell profit after entry/exit trading costs, and team call counts. Open buys are not scored as realized gains. Fees are informational and must not be subtracted again from realized profit. Historical session boundaries, standalone-provider call counts, token usage, and API charges may be unavailable; these are not reconstructed as facts. Reports do not claim causal agent profitability or automatically change prompts. Future analysis should compare configurations across adequate samples and test recommendations out of sample.

Reports can be filtered by evaluation start time using `from` (inclusive) and `to` (exclusive) ISO timestamps. The Reports tab converts local calendar dates into those bounds. `deleted=true` lists hidden reports. `DELETE /api/reports/<uuid>` hides a report; `POST /api/reports/<uuid>/restore` restores it. Both require a local same-origin JSON request with `{}`. Deletion preserves the evidence payload and all trades/balances, and recovery does not recreate hidden reports.
