CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`status` text NOT NULL,
	`match_score` real,
	`match_reason` text,
	`matched_at` text,
	`payload` text,
	`telegram_message_id` text,
	`follow_up_at` text,
	`followed_up_at` text,
	`last_submitted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "applications_status_check" CHECK("applications"."status" IN ('suggested','approved','submitted','replied','handled','skipped','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_listing_id_unique` ON `applications` (`listing_id`);--> statement-breakpoint
CREATE INDEX `applications_status_follow_up_at_idx` ON `applications` (`status`,`follow_up_at`);--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`freehire_id` text NOT NULL,
	`url` text,
	`title` text,
	`company` text,
	`description` text,
	`posted_at` text,
	`location` text,
	`status` text DEFAULT 'new' NOT NULL,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "listings_status_check" CHECK("listings"."status" IN ('new','suggested','skipped','applied'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listings_freehire_id_unique` ON `listings` (`freehire_id`);--> statement-breakpoint
CREATE TABLE `replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer,
	`email_message_id` text NOT NULL,
	`from_addr` text,
	`subject` text,
	`snippet` text,
	`raw_ref` text,
	`received_at` text NOT NULL,
	`alerted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replies_email_message_id_unique` ON `replies` (`email_message_id`);
--> statement-breakpoint
-- Seed config defaults (spec 0001 AC-8: on first use these rows exist;
-- src/lib/config.ts re-ensures them on read for safety).
INSERT OR IGNORE INTO `config` (`key`, `value`) VALUES ('follow_up_hours', '5');
INSERT OR IGNORE INTO `config` (`key`, `value`) VALUES ('reply_retention_days', '20');
INSERT OR IGNORE INTO `config` (`key`, `value`) VALUES ('listing_retention_days', '25');