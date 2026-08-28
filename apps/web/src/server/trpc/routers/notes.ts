import { z } from "zod";
import { notes, categories, sessions, notebooks } from "@lib/db";
import { desc, eq, and, asc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";

export const notesRouter = router({
  getNotebook: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [notebook] = await ctx.db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, input.id))
        .limit(1);
      return notebook ?? null;
    }),

  listCategories: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db
        .select()
        .from(categories)
        .where(eq(categories.notebookId, input.notebookId))
        .orderBy(asc(categories.position));
    }),

  createCategory: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = nanoid();
      const now = new Date();
      await ctx.db.insert(categories).values({
        id,
        notebookId: input.notebookId,
        name: input.name,
        position: Date.now(),
        createdAt: now,
      });
      return { id };
    }),

  listNotes: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        sort: z.enum(["latest", "name"]).default("latest"),
      }),
    )
    .query(async ({ input, ctx }) => {
      const orderBy =
        input.sort === "name" ? asc(notes.name) : desc(notes.updatedAt);
      return ctx.db
        .select()
        .from(notes)
        .where(eq(notes.notebookId, input.notebookId))
        .orderBy(orderBy);
    }),

  createNote: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        categoryId: z.string().nullable(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = nanoid();
      const now = new Date();
      await ctx.db.insert(notes).values({
        id,
        notebookId: input.notebookId,
        categoryId: input.categoryId,
        name: input.name,
        position: Date.now(),
        createdAt: now,
        updatedAt: now,
      });
      return { id };
    }),

  updateNote: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        content: z.string().optional(),
        categoryId: z.string().nullable().optional(),
        active: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const updates: Record<string, unknown> = { ...data };
      if (data.content !== undefined) {
        updates.wordCount = data.content
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
      }
      updates.updatedAt = new Date();
      await ctx.db.update(notes).set(updates).where(eq(notes.id, id));
      return { id };
    }),

  batchUpdateNotes: publicProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
        archived: z.boolean().optional(),
        active: z.boolean().optional(),
        categoryId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { ids, ...data } = input;
      if (ids.length === 0) return;
      const updates: Record<string, unknown> = { ...data };
      updates.updatedAt = new Date();
      await ctx.db
        .update(notes)
        .set(updates)
        .where(inArray(notes.id, ids));
    }),

  deleteNote: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.delete(notes).where(eq(notes.id, input.id));
    }),

  // Sessions
  listSessions: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(sessions)
        .where(eq(sessions.notebookId, input.notebookId))
        .orderBy(desc(sessions.lastMessageAt));
      if (input.search) {
        const q = input.search.toLowerCase();
        return rows.filter((s) => s.name.toLowerCase().includes(q));
      }
      return rows;
    }),

  createSession: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = nanoid();
      const now = new Date();
      await ctx.db.insert(sessions).values({
        id,
        notebookId: input.notebookId,
        name: input.name,
        createdAt: now,
        lastMessageAt: now,
      });
      return { id };
    }),
});
