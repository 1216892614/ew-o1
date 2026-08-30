import { z } from "zod";
import { snapshots, notes } from "@lib/db";
import { eq, and, desc, gte, lte, inArray } from "drizzle-orm";
import { publicProcedure, router } from "../init";
import { revertToSnapshot } from "../../utils/snapshot";

function parseJsonField(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const timeMachineRouter = router({
  /**
   * List snapshots for a notebook with optional filters and cursor pagination.
   */
  list: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        noteId: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(snapshots.notebookId, input.notebookId)];

      if (input.dateFrom) {
        conditions.push(gte(snapshots.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        conditions.push(lte(snapshots.createdAt, new Date(input.dateTo)));
      }
      if (input.noteId) {
        conditions.push(eq(snapshots.noteId, input.noteId));
      }
      if (input.cursor) {
        conditions.push(lte(snapshots.createdAt, new Date(input.cursor)));
      }

      const rows = await ctx.db
        .select({
          id: snapshots.id,
          noteId: snapshots.noteId,
          action: snapshots.action,
          summary: snapshots.summary,
          source: snapshots.source,
          sessionName: snapshots.sessionName,
          toolName: snapshots.toolName,
          beforeData: snapshots.beforeData,
          afterData: snapshots.afterData,
          revertTargetId: snapshots.revertTargetId,
          createdAt: snapshots.createdAt,
          noteName: notes.name,
        })
        .from(snapshots)
        .leftJoin(notes, eq(snapshots.noteId, notes.id))
        .where(and(...conditions))
        .orderBy(desc(snapshots.createdAt))
        .limit(input.limit + 1);

      let nextCursor: string | undefined;
      if (rows.length > input.limit) {
        const last = rows.pop()!;
        nextCursor = last.createdAt.toISOString();
      }

      const items = rows.map((r) => ({
        id: r.id,
        noteId: r.noteId,
        noteName: r.noteName ?? null,
        action: r.action,
        summary: r.summary,
        source: r.source,
        sessionName: r.sessionName,
        toolName: r.toolName,
        beforeData: parseJsonField(r.beforeData),
        afterData: parseJsonField(r.afterData),
        revertTargetId: r.revertTargetId,
        createdAt: r.createdAt.toISOString(),
      }));

      return { items, nextCursor };
    }),

  /**
   * Get full detail for a single snapshot.
   */
  getDetail: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [row] = await ctx.db
        .select({
          id: snapshots.id,
          notebookId: snapshots.notebookId,
          noteId: snapshots.noteId,
          action: snapshots.action,
          summary: snapshots.summary,
          source: snapshots.source,
          sessionName: snapshots.sessionName,
          toolName: snapshots.toolName,
          beforeData: snapshots.beforeData,
          afterData: snapshots.afterData,
          revertTargetId: snapshots.revertTargetId,
          createdAt: snapshots.createdAt,
          noteName: notes.name,
        })
        .from(snapshots)
        .leftJoin(notes, eq(snapshots.noteId, notes.id))
        .where(eq(snapshots.id, input.id))
        .limit(1);

      if (!row) return null;

      return {
        id: row.id,
        notebookId: row.notebookId,
        noteId: row.noteId,
        noteName: row.noteName ?? null,
        action: row.action,
        summary: row.summary,
        source: row.source,
        sessionName: row.sessionName,
        toolName: row.toolName,
        beforeData: parseJsonField(row.beforeData),
        afterData: parseJsonField(row.afterData),
        revertTargetId: row.revertTargetId,
        createdAt: row.createdAt.toISOString(),
      };
    }),

  /**
   * Revert a notebook to a given snapshot.
   */
  revert: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        snapshotId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await revertToSnapshot(
        ctx.db,
        ctx.env,
        input.notebookId,
        input.snapshotId,
      );
      return { success: result.success, error: result.error };
    }),

  /**
   * List distinct notes that have snapshots, for the file filter dropdown.
   */
  involvedFiles: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .selectDistinct({ noteId: snapshots.noteId })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.notebookId, input.notebookId),
            // noteId is not null — only note-level snapshots
          ),
        );

      const noteIds = rows
        .map((r) => r.noteId)
        .filter((id): id is string => id !== null);

      if (noteIds.length === 0) return [];

      const noteRows = await ctx.db
        .select({ id: notes.id, name: notes.name })
        .from(notes)
        .where(inArray(notes.id, noteIds));

      return noteRows.map((n) => ({ noteId: n.id, noteName: n.name }));
    }),
});
