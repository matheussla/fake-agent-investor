# Paper Crypto Investor

A local paper trading app that uses live Binance spot market data and configurable Grok and Codex decision providers. The app only simulates orders; it has no live trading adapter.

## Requirements

- macOS or Linux
- Node.js 24.11.1 (see `.node-version`)
- pnpm 10
- Docker with Docker Compose
- An xAI API key for Grok decisions or an OpenAI API key for Codex decisions

Codex decisions use the OpenAI Responses API with `gpt-5.3-codex` by default. No tools are exposed to the model. The app never launches the Codex CLI or reads its credentials.

## Start locally

```sh
pnpm install
cp .env.example .env
```

Set `XAI_API_KEY` in `.env` to enable Grok, or `OPENAI_API_KEY` to enable Codex. The server reads this file at startup. Keep `.env` private; it is ignored by Git.

Start PostgreSQL and apply the schema:

```sh
pnpm db:up
pnpm db:migrate
```

Start the local API and web app:

```sh
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API binds to `127.0.0.1:3000`. On first run, open Settings and choose the starting virtual USDT balance. That balance stays fixed for the simulation; choose a new balance only when resetting it. Configure trading settings and a strategy prompt, save while the agent is paused, then start or pause the agent from Settings. The app continues market ingestion and valuation while the agent is paused.

The dashboard market picker searches active Binance USDT spot pairs, including markets outside the agent's configured watchlist. Candle history loads on demand and refreshes every 15 seconds. Browsing a market does not add it to the trading strategy. Switching between Dashboard, Agents, and Settings preserves chart selections and unsaved drafts within the current browser session; reloading the browser clears unsaved drafts.

To stop PostgreSQL, run `pnpm db:down`. Its Docker volume is retained.

## Agent team

Open **Agents** to manage the Trading Lead, Market Analyst, Momentum Analyst, Risk Analyst, and Skeptic. Each agent has a separate versioned prompt. You can add up to ten agents, disable or archive specialists, and assign a different enabled lead while the team is paused and idle.

Use Team chat to address the lead, or select an agent for an individual conversation. Agent handoffs appear in the activity feed. Chat is discussion-only: **Start team** and **Run once** authorize trading cycles, and only the lead's final decision reaches the existing paper execution and risk checks.

The harness runs up to five requests concurrently, with one turn per agent. Runs are bounded to 20 model calls and three minutes; each request has a one-minute timeout. The daily model-call allowance defaults to 300 and can be changed in Settings. All agent requests count toward this allowance. A five-agent cycle uses at least six calls, including lead finalization. Pause cancels pending work; restarting the server preserves transcripts and leaves interrupted work stopped.

Apply database migrations before starting the updated server. Existing strategies become lead prompts and the migrated team starts paused. Reset retains the roster, prompts, and settings in a new simulation; old conversation history remains attached to the archived simulation. Daily usage does not reset with the portfolio.

Decision snapshots include up to 60 closed one-minute candles per configured asset from the last two hours, in chronological order. Missing history remains empty; future and unfinished candles are excluded. This gives agents price history without unbounded prompts or network requests during decision capture.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | API bind address. Other bind addresses are rejected. |
| `PORT` | `3000` | API port. |
| `DATABASE_URL` | `postgres://paper:paper@127.0.0.1:5433/paper_investor` | PostgreSQL connection. |
| `XAI_API_KEY` | unset | Server-side Grok API credential. |
| `OPENAI_API_KEY` | unset | Server-side Codex API credential. |

The initial strategy watches BTC/USDT, ETH/USDT, and SOL/USDT, with a five-minute decision cadence. Risk defaults cap a buy at 10% of equity, a single asset at 25%, total exposure at 50%, and daily equity loss at 5%. Fees and slippage are simulated settings. Both providers validate decisions before they can reach paper execution. To use Codex, pause the agent, select **Codex API** in Settings, and save; switching providers selects the matching default model. Codex requests count toward the daily allowance. Team chat and agent collaboration support both providers. The selected provider and model apply to all team members; each turn counts once toward the shared daily allowance.

API and dashboard controls are local and same-origin only. Do not expose the app to a public network.

## Smoke checks

These checks never submit orders:

```sh
pnpm smoke:binance
pnpm smoke:grok
pnpm smoke:codex
```

- `smoke:binance` makes bounded public REST requests for exchange instruments, one BTC/USDT quote, and recent one-minute candles.
- `smoke:grok` sends at most one validated decision request using the active simulation and fresh quotes, then discards the decision. It requires `XAI_API_KEY`, a migrated database, and a running app to populate market data. Without a key, it reports a skip without sending a request. The request has a 30-second deadline.
- `smoke:codex` sends one real Codex API request with synthetic data and no market quotes, validates a hold decision, and discards it. It requires `OPENAI_API_KEY`, has a 30-second deadline, and needs no database or running app. Missing credentials or a failed request exit unsuccessfully. This standalone connectivity check does not update the simulation usage ledger.

The smoke scripts print request results and decisions without printing credentials, prompts, or portfolio snapshots.

## Validation

Start Docker first, then use the isolated test database:

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

See [docs/validation.md](docs/validation.md) for coverage and system validation details. Integration tests truncate data in `paper_investor_test`; they do not use the application database.

### Execution safety and latency

Paper fills retain a single PostgreSQL transaction for orders, fills, ledger movements, and positions. Trades, valuation, and daily-loss enforcement lock the simulation in the same order, preventing concurrent overspending, overselling, or mixed portfolio snapshots. Failed or cancelled transactions roll back. Once COMMIT has been sent, cancellation cannot undo a completed fill; retry the same request to discover its stored outcome.

Run Once retains its request ID in session storage until the server confirms it, including across navigation and reloads. Execution retries return the original filled or rejected order. Reusing a decision ID with a different side, symbol, quantity, generation, or configuration fails with an idempotency conflict.

Execution uses fresh in-memory Binance quotes when available, with indexed latest-sample lookups as a fallback. No market network requests run while a portfolio transaction holds its lock. Binance instrument metadata is cached for five minutes; concurrent callers share a ten-second bounded refresh without cancelling each other. Execution has a five-second cancellation deadline, database lock waits are capped at two seconds, and database statements and connection acquisition are bounded at five seconds. An in-flight statement may finish before cancellation is checked; cancellation is checked again before COMMIT.

Strategy settings include **Maximum decision age** (default 60 seconds, range 1–180) and **Maximum adverse price movement** (default 50 basis points, range 0–500). These are separate from simulated slippage. Old decisions and prices moving against the proposed trade are rejected and recorded. Favorable price movement still passes through all existing risk checks. Existing configurations receive the same defaults without rewriting their history.

Decision records include execution duration and decision age in milliseconds. The cadence and model-call allowance remain strategy controls; database optimizations do not shorten the AI deliberation cycle or guarantee profitable trades. Apply migration `0006_quote_symbol_received` with the normal migration command before benchmarking quote history lookups.

### Saved trading reports

Every terminal trading evaluation (including HOLD, failure, and rejection) is saved as a versioned JSON `decision_report` in PostgreSQL `operational_events`. Startup and a 30-second recovery job backfill missing reports in batches of 100. Report-write failures are logged and retried without changing a completed trade. Back up PostgreSQL to retain these reports outside this machine.

The **Reports** tab downloads recent reports. Local same-origin APIs:
- `GET /api/reports?simulationId=<uuid>&limit=20&before=<ISO timestamp>` lists saved reports (maximum 100 per page).
- `GET /api/reports/<report UUID>` downloads the complete JSON evidence.
- `GET /api/trading-sessions?simulationId=<uuid>` retrieves persisted session start/stop events.

Schema version 1 retains the decision input snapshot, configuration, team snapshot (including versioned prompts), individual turns/messages, orders, fills, and ledger entries. Money remains decimal strings. Metrics include filled/rejected counts, fees, turnover, realized sell profit after entry/exit trading costs, and team call counts. Open buys are not scored as realized gains. Fees are informational and must not be subtracted again from realized profit. Historical session boundaries, standalone-provider call counts, token usage, and API charges may be unavailable; these are not reconstructed as facts. Reports do not claim causal agent profitability or automatically change prompts. Future analysis should compare configurations across adequate samples and test recommendations out of sample.

Reports can be filtered by evaluation start time using `from` (inclusive) and `to` (exclusive) ISO timestamps. The Reports tab converts local calendar dates into those bounds. `deleted=true` lists hidden reports. `DELETE /api/reports/<uuid>` hides a report; `POST /api/reports/<uuid>/restore` restores it. Both require a local same-origin JSON request with `{}`. Deletion preserves the evidence payload and all trades/balances, and recovery does not recreate hidden reports.
