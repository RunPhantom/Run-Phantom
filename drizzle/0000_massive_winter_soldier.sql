CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`span_id` text,
	`kind` text NOT NULL,
	`note` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_annotations_run` ON `annotations` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_annotations_span` ON `annotations` (`span_id`) WHERE "annotations"."span_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `live_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text,
	`type` text NOT NULL,
	`content` text,
	`timestamp` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_live_trace` ON `live_events` (`trace_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`state_updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session_created` ON `messages` (`session_id`,"created_at" asc);--> statement-breakpoint
CREATE INDEX `idx_messages_state` ON `messages` (`state`,`state_updated_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`name` text,
	`event_name` text,
	`user_id` text,
	`convo_id` text,
	`started_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_runs_last_updated` ON `runs` (`last_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_event_id` ON `runs` (`event_id`) WHERE "runs"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `saved_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_name` text NOT NULL,
	`user_id` text,
	`convo_id` text,
	`timestamp` text NOT NULL,
	`user_input` text,
	`assistant_output` text,
	`signals` text,
	`properties` text,
	`saved_at` integer NOT NULL,
	`summary` text,
	`source` text,
	`folder` text
);
--> statement-breakpoint
CREATE INDEX `idx_saved_events_saved_at` ON `saved_events` ("saved_at" desc);--> statement-breakpoint
CREATE INDEX `idx_saved_events_folder` ON `saved_events` (`folder`);--> statement-breakpoint
CREATE TABLE `saved_folders` (
	`name` text PRIMARY KEY NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_run_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deactivated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_active_created` ON `sessions` (`active`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `spans` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`span_type` text,
	`status` text DEFAULT 'UNSET',
	`input_payload` text,
	`output_payload` text,
	`start_time_ms` real,
	`end_time_ms` real,
	`duration_ms` real,
	`model` text,
	`provider` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`attributes` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_spans_run_id` ON `spans` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_spans_parent` ON `spans` (`parent_span_id`);