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

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
