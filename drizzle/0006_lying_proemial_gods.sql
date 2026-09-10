CREATE TABLE `evaluation_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`latest_version` integer NOT NULL,
	`case_count` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evaluation_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`job_token` text NOT NULL,
	`completed_checks` integer NOT NULL,
	`data` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_evaluation_experiments_status` ON `evaluation_experiments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_evaluation_experiments_created` ON `evaluation_experiments` (`created_at`);--> statement-breakpoint
CREATE TABLE `evaluation_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rating` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `evaluation_experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_evaluation_reviews_experiment` ON `evaluation_reviews` (`experiment_id`);--> statement-breakpoint
CREATE TABLE `evaluation_revisions` (
	`dataset_id` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`cases` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`dataset_id`, `version`),
	FOREIGN KEY (`dataset_id`) REFERENCES `evaluation_datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
