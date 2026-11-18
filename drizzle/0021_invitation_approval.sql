ALTER TABLE "invitations" ADD COLUMN "status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email" text;