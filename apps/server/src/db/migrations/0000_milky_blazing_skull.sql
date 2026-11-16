CREATE TYPE "public"."execution_status" AS ENUM('accepted', 'rejected', 'filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."simulation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "agent_state" (
	"simulation_id" uuid PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"pause_reason" text
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"volume" numeric(38, 18) NOT NULL,
	"closed" boolean NOT NULL,
	CONSTRAINT "candle_symbol_open" UNIQUE("symbol","open_time")
);
--> statement-breakpoint
CREATE TABLE "configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configurations_sim_version" UNIQUE("simulation_id","version")
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utc_date" text NOT NULL,
	"provider" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"daily_baseline" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_date_provider" UNIQUE("utc_date","provider")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"run_generation" integer NOT NULL,
	"configuration_version" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"result" jsonb,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_sim_request" UNIQUE("simulation_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "equity_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"cash" numeric(38, 18) NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	"realized_profit" numeric(38, 18) NOT NULL,
	"unrealized_profit" numeric(38, 18) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "equity_sim_minute" UNIQUE("simulation_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"simulation_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" "order_side" NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"fee" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fills_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"fill_id" uuid,
	"asset" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" "order_side" NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"status" "execution_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_one_per_decision" UNIQUE("decision_id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"cost_basis" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_sim_symbol" UNIQUE("simulation_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_sim_name_version" UNIQUE("simulation_id","name","version")
);
--> statement-breakpoint
CREATE TABLE "quote_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"bid" numeric(38, 18) NOT NULL,
	"ask" numeric(38, 18) NOT NULL,
	"bid_size" numeric(38, 18) NOT NULL,
	"ask_size" numeric(38, 18) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quote_symbol_observed" UNIQUE("symbol","observed_at")
);
--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "simulation_status" DEFAULT 'active' NOT NULL,
	"starting_cash" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurations" ADD CONSTRAINT "configurations_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_history" ADD CONSTRAINT "equity_history_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_fill_id_fills_id_fk" FOREIGN KEY ("fill_id") REFERENCES "public"."fills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candle_close_time" ON "candles" USING btree ("close_time");--> statement-breakpoint
CREATE INDEX "equity_sim_time" ON "equity_history" USING btree ("simulation_id","observed_at");--> statement-breakpoint
CREATE INDEX "ledger_sim_time" ON "ledger_entries" USING btree ("simulation_id","created_at");--> statement-breakpoint
CREATE INDEX "events_sim_time" ON "operational_events" USING btree ("simulation_id","created_at");--> statement-breakpoint
CREATE INDEX "quote_observed" ON "quote_samples" USING btree ("observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulations_one_active" ON "simulations" USING btree ("status") WHERE status = 'active';--> statement-breakpoint
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger entries are immutable'; END; $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
