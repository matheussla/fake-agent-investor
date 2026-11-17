ALTER TABLE "agent_state" ADD COLUMN "cycle_running" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_state" ADD COLUMN "claimed_request_id" uuid;