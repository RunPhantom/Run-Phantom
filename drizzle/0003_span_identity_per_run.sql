/*
 Span identity is scoped to its run.

 `spans.id` was a bare global PRIMARY KEY, but the OpenTelemetry spec only requires
 a SpanId to be unique *within a trace*. Two independent traces that reused a span
 id therefore collided: the upsert rewrote the existing row's run_id, silently
 moving the span onto the newer run, so the older run's span_count dropped and its
 trajectory lost a bar. Making the key (run_id, id) lets both rows coexist, which
 is what the spec allows.

 Rebuild is required because SQLite cannot alter a PRIMARY KEY in place.
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_spans` (
	`id` text NOT NULL,
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
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_spans` SELECT `id`,`run_id`,`parent_span_id`,`name`,`span_type`,`status`,`input_payload`,`output_payload`,`start_time_ms`,`end_time_ms`,`duration_ms`,`model`,`provider`,`input_tokens`,`output_tokens`,`attributes` FROM `spans`;--> statement-breakpoint
DROP TABLE `spans`;--> statement-breakpoint
ALTER TABLE `__new_spans` RENAME TO `spans`;--> statement-breakpoint
CREATE INDEX `idx_spans_run_id` ON `spans` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_spans_parent` ON `spans` (`parent_span_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
