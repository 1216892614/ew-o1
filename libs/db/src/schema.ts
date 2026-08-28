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
