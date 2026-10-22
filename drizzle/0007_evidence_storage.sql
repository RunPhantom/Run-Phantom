CREATE TABLE `evaluation_evidence_artifacts` (
	`scope_key` text NOT NULL,
	`id` text NOT NULL,
	`job_id` text NOT NULL,
	`source_id` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_length` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `id`),
	FOREIGN KEY (`job_id`) REFERENCES `evaluation_evidence_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_artifact_length" CHECK("evaluation_evidence_artifacts"."byte_length">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_artifact_source` ON `evaluation_evidence_artifacts` (`job_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `evaluation_evidence_blobs` (
	`scope_key` text NOT NULL,
	`artifact_id` text NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`scope_key`, `artifact_id`),
	FOREIGN KEY (`scope_key`,`artifact_id`) REFERENCES `evaluation_evidence_artifacts`(`scope_key`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_interpretations` (
	`scope_key` text NOT NULL,
	`id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`normalized_sha256` text NOT NULL,
	`parser_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`configuration_sha256` text NOT NULL,
	`dialect` text NOT NULL,
	PRIMARY KEY(`scope_key`, `id`),
	FOREIGN KEY (`scope_key`,`artifact_id`) REFERENCES `evaluation_evidence_artifacts`(`scope_key`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_inventories` (
	`scope_key` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `id`, `revision`),
	FOREIGN KEY (`scope_key`,`id`) REFERENCES `evaluation_evidence_inventory_heads`(`scope_key`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_inventory_revision" CHECK("evaluation_evidence_inventories"."revision">0)
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_inventory_heads` (
	`scope_key` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `id`),
	FOREIGN KEY (`scope_key`) REFERENCES `evaluation_evidence_scopes`(`scope_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_head_revision" CHECK("evaluation_evidence_inventory_heads"."revision">=0)
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`scope_generation` integer NOT NULL,
	`operation_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`request_data` text NOT NULL,
	`inventory_data` text,
	`status` text NOT NULL,
	`job_token` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`reserved_raw_bytes` integer NOT NULL,
	`reserved_normalized_bytes` integer NOT NULL,
	`set_id` text,
	`failure_code` text,
	FOREIGN KEY (`scope_key`) REFERENCES `evaluation_evidence_scopes`(`scope_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_job_status" CHECK("evaluation_evidence_jobs"."status" IN ('queued','running','completed','cancelled','failed')),
	CONSTRAINT "evidence_job_raw_reservation" CHECK("evaluation_evidence_jobs"."reserved_raw_bytes">=0),
	CONSTRAINT "evidence_job_normalized_reservation" CHECK("evaluation_evidence_jobs"."reserved_normalized_bytes">=0)
);
--> statement-breakpoint
CREATE INDEX `evaluation_evidence_jobs_status` ON `evaluation_evidence_jobs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_job_operation` ON `evaluation_evidence_jobs` (`scope_key`,`scope_generation`,`operation_key`);--> statement-breakpoint
CREATE TABLE `evaluation_evidence_payloads` (
	`scope_key` text NOT NULL,
	`interpretation_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`scope_key`, `interpretation_id`),
	FOREIGN KEY (`scope_key`,`interpretation_id`) REFERENCES `evaluation_evidence_interpretations`(`scope_key`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_retention_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`set_id` text NOT NULL,
	`revision` integer NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scope_key`) REFERENCES `evaluation_evidence_scopes`(`scope_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_retention_kind" CHECK("evaluation_evidence_retention_events"."kind" IN ('raw_removed','normalized_removed'))
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_scopes` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`active` integer NOT NULL,
	CONSTRAINT "evidence_scope_generation" CHECK("evaluation_evidence_scopes"."generation">0),
	CONSTRAINT "evidence_scope_active" CHECK("evaluation_evidence_scopes"."active" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `evaluation_evidence_sets` (
	`scope_key` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`job_id` text NOT NULL,
	`data` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `id`, `revision`),
	FOREIGN KEY (`job_id`) REFERENCES `evaluation_evidence_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_set_revision" CHECK("evaluation_evidence_sets"."revision">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_set_job` ON `evaluation_evidence_sets` (`job_id`);
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_inventories_immutable BEFORE UPDATE ON evaluation_evidence_inventories BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_artifacts_immutable BEFORE UPDATE ON evaluation_evidence_artifacts BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_blobs_immutable BEFORE UPDATE ON evaluation_evidence_blobs BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_interpretations_immutable BEFORE UPDATE ON evaluation_evidence_interpretations BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_payloads_immutable BEFORE UPDATE ON evaluation_evidence_payloads BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_sets_immutable BEFORE UPDATE ON evaluation_evidence_sets BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_evidence_retention_events_immutable BEFORE UPDATE ON evaluation_evidence_retention_events BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
