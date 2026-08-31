import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const notebooks = sqliteTable("notebooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").default(""),
  color: text("color").default("#6366f1"),
  icon: text("icon").default("notebook"),
  fileCount: integer("file_count").default(0),
  archived: integer("archived", { mode: "boolean" }).default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  notebookId: text("notebook_id")
    .notNull()
    .references(() => notebooks.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  isArchive: integer("is_archive", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  notebookId: text("notebook_id")
    .notNull()
    .references(() => notebooks.id, { onDelete: "cascade" }),
  categoryId: text("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  content: text("content").default(""),
  wordCount: integer("word_count").default(0),
  active: integer("active", { mode: "boolean" }).default(true),
  archived: integer("archived", { mode: "boolean" }).default(false),
  position: integer("position").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  notebookId: text("notebook_id")
    .notNull()
    .references(() => notebooks.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  modelId: text("model_id"),
  modelName: text("model_name"),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  notebookId: text("notebook_id")
    .notNull()
    .references(() => notebooks.id, { onDelete: "cascade" }),
  /** Which note was affected (null for notebook-level changes like toml) */
  noteId: text("note_id").references(() => notes.id, { onDelete: "set null" }),
  /** "create_note" | "update_content" | "update_meta" | "delete_note" | "batch_update" | "revert" */
  action: text("action").notNull(),
  /** Human-readable summary, e.g. "重命名为 xxx" or "回溯到版本 #3" */
  summary: text("summary").notNull(),
  /** "user" | "agent" */
  source: text("source").notNull().default("user"),
  /** If source=agent, the session name */
  sessionName: text("session_name"),
  /** If source=agent, the tool that triggered the change */
  toolName: text("tool_name"),
  /** JSON blob: snapshot of the state before the change */
  beforeData: text("before_data"),
  /** JSON blob: snapshot of the state after the change */
  afterData: text("after_data"),
  /** If this is a revert, which snapshot id it reverted to */
  revertTargetId: text("revert_target_id"),
  diffData: text("diff_data"),
  parentSnapshotId: text("parent_snapshot_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

