CREATE TABLE `notebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '',
	`color` text DEFAULT '#6366f1',
	`icon` text DEFAULT 'notebook',
	`file_count` integer DEFAULT 0,
	`archived` integer DEFAULT false,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
