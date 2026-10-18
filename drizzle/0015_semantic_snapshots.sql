CREATE TABLE `verification_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text,
  `session_id` text,
  `name` text NOT NULL,
  `origin` text NOT NULL,
  `captured_at` integer NOT NULL,
  `stored_at` integer NOT NULL,
  `source` text NOT NULL,
  `content_sha256` text NOT NULL,
  `coverage_sha256` text NOT NULL,
  `payload` text NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `verification_snapshots_payload_bound` CHECK(json_valid(`payload`) AND length(cast(`payload` AS blob)) <= 32768),
  CONSTRAINT `verification_snapshots_text_bound` CHECK(length(`id`) BETWEEN 1 AND 128 AND length(cast(`id` AS blob)) <= 512 AND length(`name`) BETWEEN 1 AND 128 AND length(cast(`name` AS blob)) <= 512 AND length(cast(`origin` AS blob)) BETWEEN 1 AND 2048 AND (`session_id` IS NULL OR length(cast(`session_id` AS blob)) BETWEEN 1 AND 512)),
  CONSTRAINT `verification_snapshots_time_bound` CHECK(typeof(`captured_at`) = 'integer' AND `captured_at` BETWEEN 0 AND 9007199254740991 AND typeof(`stored_at`) = 'integer' AND `stored_at` BETWEEN 0 AND 9007199254740991),
  CONSTRAINT `verification_snapshots_source_bound` CHECK((`source` = 'paired-sdk' AND `session_id` IS NOT NULL) OR (`source` = 'imported-evidence' AND `session_id` IS NULL)),
  CONSTRAINT `verification_snapshots_digest_bound` CHECK(length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^0-9a-f]*' AND length(`coverage_sha256`) = 64 AND `coverage_sha256` NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `idx_verification_snapshots_stored` ON `verification_snapshots` (`stored_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_verification_snapshots_run` ON `verification_snapshots` (`run_id`,`stored_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `verification_snapshots_no_update` BEFORE UPDATE ON `verification_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'semantic snapshots are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `verification_snapshots_capacity` BEFORE INSERT ON `verification_snapshots`
WHEN (SELECT count(*) FROM `verification_snapshots`) >= 100
BEGIN
  SELECT RAISE(ABORT, 'semantic snapshot capacity exceeded');
END;
