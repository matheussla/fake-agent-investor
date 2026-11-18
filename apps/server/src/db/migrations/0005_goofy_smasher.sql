CREATE TABLE "agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_lead_enabled" CHECK (NOT is_lead OR (enabled AND NOT archived))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"simulation_id" uuid NOT NULL,
	"run_id" uuid,
	"sender_agent_id" uuid,
	"recipient_agent_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'delivered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "team_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_agent_id" uuid,
	"decision_id" uuid,
	"generation" integer NOT NULL,
	"configuration_version" integer NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "team_runs_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "prompts" DROP CONSTRAINT "prompts_sim_name_version";--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_run_id_team_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."team_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_team_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."team_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_runs" ADD CONSTRAINT "team_runs_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_runs" ADD CONSTRAINT "team_runs_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_runs" ADD CONSTRAINT "team_runs_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turns_run_status" ON "agent_turns" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_lead" ON "agents" USING btree ("simulation_id") WHERE is_lead;--> statement-breakpoint
CREATE INDEX "messages_sim_sequence" ON "chat_messages" USING btree ("simulation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "team_runs_one_working" ON "team_runs" USING btree ("simulation_id") WHERE status = 'working';--> statement-breakpoint
CREATE INDEX "team_runs_sim_time" ON "team_runs" USING btree ("simulation_id","created_at");--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_agent_name_version" UNIQUE("agent_id","name","version");--> statement-breakpoint
INSERT INTO agents(simulation_id,name,is_lead) SELECT id,'Trading Lead',true FROM simulations;
--> statement-breakpoint
UPDATE prompts SET agent_id=a.id FROM agents a WHERE prompts.simulation_id=a.simulation_id AND a.is_lead=true;
--> statement-breakpoint
INSERT INTO agents(simulation_id,name) SELECT s.id,n.name FROM simulations s CROSS JOIN (VALUES ('Market Analyst'),('Momentum Analyst'),('Risk Analyst'),('Skeptic')) AS n(name) WHERE s.status='active';
--> statement-breakpoint
INSERT INTO prompts(simulation_id,agent_id,name,version,content,active)
SELECT simulation_id,id,'Instructions',1,
CASE name
 WHEN 'Market Analyst' THEN 'Analyze supplied market prices and liquidity. Share evidence and uncertainties. Never invent market data.'
 WHEN 'Momentum Analyst' THEN 'Assess momentum using supplied evidence. Ask teammates for missing evidence and distinguish observations from assumptions.'
 WHEN 'Risk Analyst' THEN 'Review exposure, liquidity and configured risk limits. Challenge proposals that exceed limits.'
 ELSE 'Challenge trading proposals. Identify missing evidence and downside scenarios. Recommend holding when evidence is insufficient.' END,true FROM agents WHERE is_lead=false;
--> statement-breakpoint
UPDATE configurations SET values=values || '{"dailyAttemptLimit":300}'::jsonb WHERE NOT values ? 'dailyAttemptLimit';
--> statement-breakpoint
UPDATE decisions d SET failure='interrupted by team migration' FROM agent_state a WHERE d.simulation_id=a.simulation_id AND a.cycle_running=true AND d.request_id=a.claimed_request_id AND d.result IS NULL AND d.failure IS NULL;
--> statement-breakpoint
UPDATE agent_state SET paused=true,generation=generation+1,cycle_running=false,claimed_request_id=NULL,pause_reason='team_migration';
