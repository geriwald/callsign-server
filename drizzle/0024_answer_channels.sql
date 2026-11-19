ALTER TABLE "owners" ADD COLUMN "answer_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "answer_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "answer_email_address" text;