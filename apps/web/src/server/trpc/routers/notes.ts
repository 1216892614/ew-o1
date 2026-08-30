import { z } from "zod";
import { notes, categories, sessions, notebooks } from "@lib/db";
import { desc, eq, and, asc, inArray, sql, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";
import {
  addFileToNotebookToml,
  updateFileInNotebookToml,
  removeFileFromNotebookToml,
} from "../../utils/r2Sync";

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
      const allCats = await ctx.db
        .select()
        .from(categories)
        .where(eq(categories.notebookId, input.notebookId))
        .orderBy(asc(categories.position));

      // Prune empty non-archive categories (they shouldn't persist in storage)
      const emptyCatIds: string[] = [];
      for (const cat of allCats) {
        if (cat.isArchive) continue;
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(notes)
          .where(eq(notes.categoryId, cat.id))
          .limit(1);
        if ((row?.count ?? 0) === 0) {
          emptyCatIds.push(cat.id);
        }
      }
      if (emptyCatIds.length > 0) {
        await ctx.db
          .delete(categories)
          .where(inArray(categories.id, emptyCatIds));
      }

      return allCats.filter((c) => !emptyCatIds.includes(c.id));
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

      let tag = "";
      if (input.categoryId) {
        const [cat] = await ctx.db
          .select({ name: categories.name })
          .from(categories)
          .where(eq(categories.id, input.categoryId))
          .limit(1);
        tag = cat?.name ?? "";
      }
      await addFileToNotebookToml(ctx.env.R2, input.notebookId, {
        filename: `${input.name}.md`,
        id,
        tag,
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

      // Sync R2 toml when name or categoryId changes
      const needsR2 = data.name !== undefined || data.categoryId !== undefined;
      if (needsR2) {
        const [note] = await ctx.db
          .select({ notebookId: notes.notebookId })
          .from(notes)
          .where(eq(notes.id, id))
          .limit(1);
        if (note) {
          const tomlUpdates: Partial<{ filename: string; tag: string }> = {};
          if (data.name !== undefined) {
            tomlUpdates.filename = `${data.name}.md`;
          }
          if (data.categoryId !== undefined) {
            let tag = "";
            if (data.categoryId) {
              const [cat] = await ctx.db
                .select({ name: categories.name })
                .from(categories)
                .where(eq(categories.id, data.categoryId))
                .limit(1);
              tag = cat?.name ?? "";
            }
            tomlUpdates.tag = tag;
          }
          await updateFileInNotebookToml(ctx.env.R2, note.notebookId, id, tomlUpdates);
        }
      }

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

      // Sync tag to R2 when categoryId changes
      if (data.categoryId !== undefined) {
        let tag = "";
        if (data.categoryId) {
          const [cat] = await ctx.db
            .select({ name: categories.name })
            .from(categories)
            .where(eq(categories.id, data.categoryId))
            .limit(1);
          tag = cat?.name ?? "";
        }
        const affectedNotes = await ctx.db
          .select({ id: notes.id, notebookId: notes.notebookId })
          .from(notes)
          .where(inArray(notes.id, ids));
        await Promise.all(
          affectedNotes.map((n) =>
            updateFileInNotebookToml(ctx.env.R2, n.notebookId, n.id, { tag }),
          ),
        );
      }
    }),

  deleteNote: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [note] = await ctx.db
        .select({ notebookId: notes.notebookId })
        .from(notes)
        .where(eq(notes.id, input.id))
        .limit(1);

      await ctx.db.delete(notes).where(eq(notes.id, input.id));

      if (note) {
        await removeFileFromNotebookToml(ctx.env.R2, note.notebookId, input.id);
      }
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
