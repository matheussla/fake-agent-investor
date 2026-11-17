CREATE TABLE "reset_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"simulation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reset_requests" ADD CONSTRAINT "reset_requests_simulation_id_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("id") ON DELETE no action ON UPDATE no action;