CREATE TABLE `verification_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`steps` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`flow_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_verification_reports_run` ON `verification_reports` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_verification_reports_created` ON `verification_reports` (`created_at`);