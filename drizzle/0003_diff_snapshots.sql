ALTER TABLE `snapshots` ADD COLUMN `diff_data` text;
ALTER TABLE `snapshots` ADD COLUMN `parent_snapshot_id` text REFERENCES `snapshots`(`id`) ON DELETE SET NULL;
