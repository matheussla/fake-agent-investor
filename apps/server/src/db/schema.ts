import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const simulationStatus = pgEnum("simulation_status", ["active", "archived"]);
export const orderSide = pgEnum("order_side", ["buy", "sell"]);
export const executionStatus = pgEnum("execution_status", ["accepted", "rejected", "filled", "cancelled"]);
const money = (name: string) => numeric(name, { precision: 38, scale: 18 });
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const simulations = pgTable("simulations", {
  id: uuid("id").defaultRandom().primaryKey(), status: simulationStatus("status").notNull().default("active"),
  startingCash: money("starting_cash").notNull(), createdAt: created(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [uniqueIndex("simulations_one_active").on(table.status).where(sql`status = 'active'`)]);

export const configurations = pgTable("configurations", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id),
  version: integer("version").notNull(), values: jsonb("values").notNull(), createdAt: created(),
}, (t) => [unique("configurations_sim_version").on(t.simulationId, t.version)]);

export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id),
  name: text("name").notNull(), enabled: boolean("enabled").notNull().default(true), isLead: boolean("is_lead").notNull().default(false), archived: boolean("archived").notNull().default(false), createdAt: created(),
}, (t) => [uniqueIndex("agents_one_lead").on(t.simulationId).where(sql`is_lead`), check("agents_lead_enabled", sql`NOT is_lead OR (enabled AND NOT archived)`)]);

export const prompts = pgTable("prompts", {
  agentId: uuid("agent_id").references(() => agents.id),
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id),
  name: text("name").notNull(), version: integer("version").notNull(), content: text("content").notNull(), active: boolean("active").notNull().default(false), createdAt: created(),
}, (t) => [unique("prompts_agent_name_version").on(t.agentId, t.name, t.version)]);

export const decisions = pgTable("decisions", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id),
  requestId: uuid("request_id").notNull(), runGeneration: integer("run_generation").notNull(), configurationVersion: integer("configuration_version").notNull(), promptVersion: integer("prompt_version").notNull(), inputSnapshot: jsonb("input_snapshot").notNull(), result: jsonb("result"), failure: text("failure"), createdAt: created(),
}, (t) => [unique("decisions_sim_request").on(t.simulationId, t.requestId)]);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), decisionId: uuid("decision_id").notNull().references(() => decisions.id),
  symbol: text("symbol").notNull(), side: orderSide("side").notNull(), quantity: money("quantity").notNull(), status: executionStatus("status").notNull(), reason: text("reason"), createdAt: created(),
}, (t) => [unique("orders_one_per_decision").on(t.decisionId)]);

export const fills = pgTable("fills", {
  id: uuid("id").defaultRandom().primaryKey(), orderId: uuid("order_id").notNull().unique().references(() => orders.id), simulationId: uuid("simulation_id").notNull().references(() => simulations.id),
  symbol: text("symbol").notNull(), side: orderSide("side").notNull(), quantity: money("quantity").notNull(), price: money("price").notNull(), fee: money("fee").notNull(), createdAt: created(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), fillId: uuid("fill_id").references(() => fills.id),
  asset: text("asset").notNull(), amount: numeric("amount", { precision: 38, scale: 18 }).notNull(), kind: text("kind").notNull(), createdAt: created(),
}, (t) => [index("ledger_sim_time").on(t.simulationId, t.createdAt)]);

export const positions = pgTable("positions", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), symbol: text("symbol").notNull(),
  quantity: money("quantity").notNull(), costBasis: money("cost_basis").notNull(), updatedAt: created(),
}, (t) => [unique("positions_sim_symbol").on(t.simulationId, t.symbol)]);

export const equityHistory = pgTable("equity_history", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), cash: money("cash").notNull(), equity: money("equity").notNull(),
  realizedProfit: numeric("realized_profit", { precision: 38, scale: 18 }).notNull(), unrealizedProfit: numeric("unrealized_profit", { precision: 38, scale: 18 }).notNull(), observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (t) => [unique("equity_sim_minute").on(t.simulationId, t.observedAt), index("equity_sim_time").on(t.simulationId, t.observedAt)]);

export const quoteSamples = pgTable("quote_samples", {
  id: uuid("id").defaultRandom().primaryKey(), symbol: text("symbol").notNull(), bid: money("bid").notNull(), ask: money("ask").notNull(), bidSize: money("bid_size").notNull(), askSize: money("ask_size").notNull(), observedAt: timestamp("observed_at", { withTimezone: true }).notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("quote_symbol_observed").on(t.symbol, t.observedAt), index("quote_observed").on(t.observedAt), index("quote_symbol_received").on(t.symbol, t.receivedAt.desc())]);

export const candles = pgTable("candles", {
  id: uuid("id").defaultRandom().primaryKey(), symbol: text("symbol").notNull(), openTime: timestamp("open_time", { withTimezone: true }).notNull(), closeTime: timestamp("close_time", { withTimezone: true }).notNull(),
  open: money("open").notNull(), high: money("high").notNull(), low: money("low").notNull(), close: money("close").notNull(), volume: money("volume").notNull(), closed: boolean("closed").notNull(),
}, (t) => [unique("candle_symbol_open").on(t.symbol, t.openTime), index("candle_close_time").on(t.closeTime)]);

export const operationalEvents = pgTable("operational_events", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").references(() => simulations.id), kind: text("kind").notNull(), payload: jsonb("payload").notNull(), createdAt: created(),
}, (t) => [index("events_sim_time").on(t.simulationId, t.createdAt)]);

export const agentState = pgTable("agent_state", {
  simulationId: uuid("simulation_id").primaryKey().references(() => simulations.id), paused: boolean("paused").notNull().default(true), generation: integer("generation").notNull().default(0), consecutiveFailures: integer("consecutive_failures").notNull().default(0), pauseReason: text("pause_reason"), cycleRunning: boolean("cycle_running").notNull().default(false), claimedRequestId: uuid("claimed_request_id"),
});

export const dailyUsage = pgTable("daily_usage", {
  id: uuid("id").defaultRandom().primaryKey(), utcDate: text("utc_date").notNull(), provider: text("provider").notNull(), attempts: integer("attempts").notNull().default(0), dailyBaseline: money("daily_baseline"), createdAt: created(),
}, (t) => [unique("usage_date_provider").on(t.utcDate, t.provider)]);

export const dailyBaselines = pgTable("daily_baselines", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), utcDate: text("utc_date").notNull(), equity: money("equity").notNull(), observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (t) => [unique("baseline_sim_day").on(t.simulationId, t.utcDate)]);

export const resetRequests = pgTable("reset_requests", {
  requestId: uuid("request_id").primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), createdAt: created(),
});

export const teamRuns = pgTable("team_runs", {
  id: uuid("id").defaultRandom().primaryKey(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), requestId: uuid("request_id").notNull().unique(), kind: text("kind").notNull(), status: text("status").notNull().default("queued"), targetAgentId: uuid("target_agent_id").references(() => agents.id), decisionId: uuid("decision_id").references(() => decisions.id), generation: integer("generation").notNull(), configurationVersion: integer("configuration_version").notNull(), snapshot: jsonb("snapshot").notNull().default({}), callCount: integer("call_count").notNull().default(0), error: text("error"), createdAt: created(), startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [uniqueIndex("team_runs_one_working").on(t.simulationId).where(sql`status = 'working'`), index("team_runs_sim_time").on(t.simulationId,t.createdAt)]);
export const agentTurns = pgTable("agent_turns", {
  id: uuid("id").defaultRandom().primaryKey(), runId: uuid("run_id").notNull().references(() => teamRuns.id), agentId: uuid("agent_id").notNull().references(() => agents.id), status: text("status").notNull().default("queued"), input: jsonb("input").notNull().default({}), output: jsonb("output"), error: text("error"), createdAt: created(), finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("turns_run_status").on(t.runId,t.status)]);
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(), sequence: bigserial("sequence", { mode: "number" }).notNull().unique(), simulationId: uuid("simulation_id").notNull().references(() => simulations.id), runId: uuid("run_id").references(() => teamRuns.id), senderAgentId: uuid("sender_agent_id").references(() => agents.id), recipientAgentId: uuid("recipient_agent_id").references(() => agents.id), kind: text("kind").notNull(), content: text("content").notNull(), status: text("status").notNull().default("delivered"), createdAt: created(),
}, (t) => [index("messages_sim_sequence").on(t.simulationId,t.sequence)]);
