import { z } from "zod";
import { notes, categories, sessions, notebooks } from "@lib/db";
import { desc, eq, and, asc, inArray, sql, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";
import {
  addFileToNotebookToml,
  updateFileInNotebookToml,
  removeFileFromNotebookToml,
  readNotebookTomlFromR2,
  writeNotebookTomlToR2,
  writeNoteContentToR2,
  deleteNoteContentFromR2,
  syncNotebookFromR2ToD1,
  bumpNotebookTimestamps,
  updateNotebookFileCount,
} from "../../utils/r2Sync";
import { upsertNoteToAiSearch, deleteNoteFromAiSearch } from "../../utils/aiSearchSync";
import { recordSnapshot } from "../../utils/snapshot";

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

  renameCategory: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get old category name before rename
      const [oldCat] = await ctx.db
        .select({ name: categories.name })
        .from(categories)
        .where(eq(categories.id, input.id))
        .limit(1);
      const oldTag = oldCat?.name ?? "";

      await ctx.db
        .update(categories)
        .set({ name: input.name })
        .where(eq(categories.id, input.id));

      // Sync R2 toml: read once, rename all matching tags, write once
      const affectedNotes = await ctx.db
        .select({ id: notes.id, notebookId: notes.notebookId })
        .from(notes)
        .where(eq(notes.categoryId, input.id));
      if (affectedNotes.length > 0) {
        // Group by notebookId (normally all same notebook, but be safe)
        const byNotebook = new Map<string, string[]>();
        for (const n of affectedNotes) {
          const arr = byNotebook.get(n.notebookId) ?? [];
          arr.push(n.id);
          byNotebook.set(n.notebookId, arr);
        }
        for (const [notebookId, fileIds] of byNotebook) {
          const toml = await readNotebookTomlFromR2(ctx.env.R2, notebookId);
          const idSet = new Set(fileIds);
          let changed = false;
          for (const file of toml.files) {
            if (idSet.has(file.id)) {
              file.tag = input.name;
              changed = true;
            }
          }
          if (changed) {
            toml.meta.updated_at = new Date();
            await writeNotebookTomlToR2(ctx.env.R2, notebookId, toml);
          }
        }
      }

      return { id: input.id };
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
      await writeNoteContentToR2(ctx.env.R2, input.notebookId, `${input.name}.md`, "");

      // Index into AI Search (fire-and-forget, new file has empty content)
      if (ctx.env.AI_SEARCH) {
        upsertNoteToAiSearch(ctx.env.AI_SEARCH, {
          notebookId: input.notebookId,
          noteId: id,
          filename: input.name,
          content: "",
        }).catch(() => {});
      }

      await recordSnapshot({
        db: ctx.db,
        notebookId: input.notebookId,
        noteId: id,
        action: "create_note",
        summary: `创建文件「${input.name}」`,
        source: "user",
        beforeContent: "",
        afterContent: "",
      });

      await updateNotebookFileCount(ctx.db, input.notebookId);
      await bumpNotebookTimestamps(ctx.env.R2, ctx.db, input.notebookId);

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
      const [beforeNote] = await ctx.db.select().from(notes).where(eq(notes.id, id)).limit(1);
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

      if (data.content !== undefined) {
        const [noteForR2] = await ctx.db
          .select({ notebookId: notes.notebookId, name: notes.name })
          .from(notes)
          .where(eq(notes.id, id))
          .limit(1);
        if (noteForR2) {
          await writeNoteContentToR2(ctx.env.R2, noteForR2.notebookId, `${noteForR2.name}.md`, data.content);
        }
      }
      if (data.content !== undefined || data.name !== undefined || data.categoryId !== undefined) {
        await bumpNotebookTimestamps(ctx.env.R2, ctx.db, beforeNote!.notebookId);
      }

      if (data.name !== undefined && beforeNote) {
        const oldName = beforeNote.name;
        if (oldName !== data.name) {
          const [noteForRename] = await ctx.db
            .select({ notebookId: notes.notebookId, content: notes.content })
            .from(notes)
            .where(eq(notes.id, id))
            .limit(1);
          if (noteForRename) {
            await deleteNoteContentFromR2(ctx.env.R2, noteForRename.notebookId, `${oldName}.md`);
            await writeNoteContentToR2(ctx.env.R2, noteForRename.notebookId, `${data.name}.md`, noteForRename.content ?? "");
          }
        }
      }

      // Re-index in AI Search when content or name changes
      const needsAiSearch = data.content !== undefined || data.name !== undefined;
      if (needsAiSearch && ctx.env.AI_SEARCH) {
        // Fetch full note for AI Search
        const [full] = await ctx.db
          .select({ notebookId: notes.notebookId, name: notes.name, content: notes.content })
          .from(notes)
          .where(eq(notes.id, id))
          .limit(1);
        if (full) {
          upsertNoteToAiSearch(ctx.env.AI_SEARCH, {
            notebookId: full.notebookId,
            noteId: id,
            filename: full.name,
            content: full.content ?? "",
          }).catch(() => {});
        }
      }

      const changedFields: string[] = [];
      if (data.name !== undefined) changedFields.push(`重命名为「${data.name}」`);
      if (data.content !== undefined) changedFields.push("修改内容");
      if (data.categoryId !== undefined) changedFields.push("修改分类");
      if (data.active !== undefined) changedFields.push(data.active ? "启用" : "停用");

      const snapshotParams: Parameters<typeof recordSnapshot>[0] = {
        db: ctx.db,
        notebookId: beforeNote!.notebookId,
        noteId: id,
        action: data.content !== undefined ? "update_content" : "update_meta",
        summary: changedFields.join("、") || "更新文件",
        source: "user",
      };

      if (data.content !== undefined) {
        snapshotParams.beforeContent = beforeNote?.content ?? "";
        snapshotParams.afterContent = data.content;
      } else {
        const metaDiff: Record<string, { before: unknown; after: unknown }> = {};
        if (data.name !== undefined && beforeNote?.name !== data.name) {
          metaDiff.name = { before: beforeNote?.name, after: data.name };
        }
        if (data.categoryId !== undefined && beforeNote?.categoryId !== data.categoryId) {
          metaDiff.categoryId = { before: beforeNote?.categoryId, after: data.categoryId };
        }
        if (data.active !== undefined && beforeNote?.active !== data.active) {
          metaDiff.active = { before: beforeNote?.active, after: data.active };
        }
        if (Object.keys(metaDiff).length > 0) {
          snapshotParams.metaDiff = metaDiff;
        }
      }

      await recordSnapshot(snapshotParams);

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

      // Sync tag to R2 when categoryId changes — read once, mutate all, write once
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
        const byNotebook = new Map<string, string[]>();
        for (const n of affectedNotes) {
          const arr = byNotebook.get(n.notebookId) ?? [];
          arr.push(n.id);
          byNotebook.set(n.notebookId, arr);
        }
        for (const [notebookId, fileIds] of byNotebook) {
          const toml = await readNotebookTomlFromR2(ctx.env.R2, notebookId);
          const idSet = new Set(fileIds);
          let changed = false;
          for (const file of toml.files) {
            if (idSet.has(file.id)) {
              file.tag = tag;
              changed = true;
            }
          }
          if (changed) {
            toml.meta.updated_at = new Date();
            await writeNotebookTomlToR2(ctx.env.R2, notebookId, toml);
          }
        }
      }
      const notebookIdsToUpdate = new Set<string>();
      const affectedForBump = await ctx.db
        .select({ notebookId: notes.notebookId })
        .from(notes)
        .where(inArray(notes.id, ids));
      for (const n of affectedForBump) notebookIdsToUpdate.add(n.notebookId);
      for (const nbId of notebookIdsToUpdate) {
        await ctx.db
          .update(notebooks)
          .set({ updatedAt: new Date() })
          .where(eq(notebooks.id, nbId));
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
      const [fullNote] = await ctx.db.select().from(notes).where(eq(notes.id, input.id)).limit(1);

      await ctx.db.delete(notes).where(eq(notes.id, input.id));

      if (note) {
        await removeFileFromNotebookToml(ctx.env.R2, note.notebookId, input.id);
        if (fullNote) {
          await deleteNoteContentFromR2(ctx.env.R2, note.notebookId, `${fullNote.name}.md`);
        }
        if (ctx.env.AI_SEARCH) {
          deleteNoteFromAiSearch(ctx.env.AI_SEARCH, {
            notebookId: note.notebookId,
            noteId: input.id,
          }).catch(() => {});
        }
      }
      if (fullNote) {
        await recordSnapshot({
          db: ctx.db,
          notebookId: fullNote.notebookId,
          noteId: input.id,
          action: "delete_note",
          summary: `删除文件「${fullNote.name}」`,
          source: "user",
          beforeContent: fullNote.content ?? "",
          afterContent: "",
        });
      }
      if (note) {
        await updateNotebookFileCount(ctx.db, note.notebookId);
        await bumpNotebookTimestamps(ctx.env.R2, ctx.db, note.notebookId);
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

  initFromR2: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await syncNotebookFromR2ToD1(ctx.env.R2, ctx.db, input.notebookId);
      return { success: true };
    }),
});
