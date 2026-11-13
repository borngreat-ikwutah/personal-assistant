CREATE TABLE `cv_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`current_version_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`current_version_id`) REFERENCES `cv_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cv_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cv_versions_size_check" CHECK("cv_versions"."size_bytes" BETWEEN 1 AND 10485760)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cv_versions_object_key_unique` ON `cv_versions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `cv_versions_idempotency_key_unique` ON `cv_versions` (`idempotency_key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `cv_documents` (`id`, `created_at`, `updated_at`)
VALUES ('primary', datetime('now'), datetime('now'));
