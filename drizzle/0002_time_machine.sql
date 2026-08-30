CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`note_id` text,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`source` text NOT NULL DEFAULT 'user',
	`session_name` text,
	`tool_name` text,
	`before_data` text,
	`after_data` text,
	`revert_target_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`notebook_id`) REFERENCES `notebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null
);
