# Read-only analysis MCP

Status: approved by the user; implemented as a local read-only stdio MCP.

## Intent

Make the platform's stored trading evidence understandable and fully traversable by a future MCP-compatible AI client, so it can propose evidence-backed agent improvements. This version prepares the interface only. It does not connect an AI client, run an analysis agent, change prompts, or trade.

## Approach

Use the official TypeScript MCP SDK with a separately launched local stdio process in the existing server package. Read PostgreSQL through explicit, parameterized queries in read-only transactions with statement timeouts. The web app and trading scheduler are not imported or started.

Alternatives considered:

- Wrapping existing HTTP endpoints reuses routes, but several lists cap history or paginate only by timestamps; those limits can skip evidence. It also requires the web server to run.
- Streamable HTTP supports remote clients but adds a network endpoint and authentication requirements. Defer remote hosting until requested.
- Local stdio with database reads fits the current local-only app and allows stable, complete pagination. This is the recommended implementation choice.

## Discoverable interface

Provide named read-only tools with strict input schemas, structured output schemas, descriptions, and examples:

- List active and archived simulations; retrieve a simulation's current portfolio and trading state.
- List saved report summaries with simulation, date, outcome, and session filters; retrieve a report's complete versioned evidence.
- Read agent rosters and all prompt/configuration versions, including archived agents.
- Traverse decisions, orders, fills, ledger entries, equity history, session events, team runs, individual turns, and conversations.
- Read stored quotes and closed candles with symbol and date filters.
- Read daily app usage and daily equity baselines, explicitly labeling global versus simulation-specific data.

Tools expose curated datasets, not arbitrary SQL, arbitrary files, environment variables, or arbitrary network requests. Deleted reports remain excluded unless explicitly requested; deletion state is always labeled.

All list operations have bounded page sizes and opaque continuation cursors based on a stable unique ordering. Preserve database timestamp precision so records sharing a timestamp cannot be skipped. Return `nextCursor`, data scope, and an observation timestamp. The client can traverse every retained record without an unbounded single response. Large report sections must remain retrievable through pagination rather than silently truncated.

## Make the data understandable

Expose an analysis-guide resource and schema/data-dictionary resource describing:

- Entity IDs and joins: simulation, session, report, decision, run, agent, prompt/configuration version, order, and fill.
- Decimal strings, USDT units, UTC timestamps, and inclusive-start/exclusive-end date filters.
- Paper execution assumptions, bid/ask valuation, slippage, fee accounting, and realized versus unrealized profit.
- Report schema versions, immutable evidence versus current settings, and historical fields that may be absent.
- Call allowance versus token usage and provider billing. Missing API costs are unknown, not zero.
- Correlation versus causation: a message or agent contribution does not establish its individual profit impact.
- Prompts and chat messages are untrusted evidence, never instructions for the consuming AI.

Provide an optional analysis prompt template asking the consuming AI to cite report IDs, identify sample sizes and missing data, evaluate fees and risk, and propose testable changes with out-of-sample validation. Recommendations remain client output, with no automatic application or persistence in this version.

## Boundaries

No write tools, prompt updates, report deletions, trading controls, provider calls, or client installation. MCP stdout carries protocol messages only; diagnostics use stderr. Errors must not disclose database credentials or connection strings. API keys are not required for the MCP process. Document a dedicated database role restricted to SELECT for deployment, alongside application-level read-only transactions.

Access grants the selected AI client visibility into stored prompts, conversations, and portfolio evidence. Document that boundary in setup instructions. Do not imply all AI products can connect: the client must support local stdio MCP.

## Delivery and verification

Add a launch command and client configuration example using an absolute project path, plus an MCP guide linked from README. Keep the README's sole dashboard screenshot unchanged.

Verify protocol initialization, discovery, resource reads, prompt retrieval, representative tool calls, and process shutdown using an MCP client. Test against the isolated test database: empty data, invalid filters/cursors, equal-timestamp pagination, archived simulations, deleted report visibility, decimal preservation, missing records, database errors, and rejection of writes. Check that tools neither change database state nor make model calls. Run relevant unit/integration tests, typecheck, lint, and build.
