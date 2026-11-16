CREATE TABLE "daily_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulation_id" uuid NOT NULL,
	"utc_date" text NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "baseline_sim_day" UNIQUE("simulation_id","utc_date")
);
--> statement-breakpoint
ALTER TABLE "daily_baselines" ADD CONSTRAINT "daily_baselines_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;