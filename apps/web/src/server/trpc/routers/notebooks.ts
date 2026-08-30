import { z } from "zod";
import { notebooks } from "@lib/db";
import { desc, lt, and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";
import { writeNotebookTomlToR2, updateNotebookMetaInR2 } from "../../utils/r2Sync";

const NOTEBOOKS_PAGE_SIZE = 20;

export const notebooksRouter = router({
  listInfinite: publicProcedure
    .input(
      z.object({
        cursor: z.string().nullish(),
        limit: z.number().min(1).max(50).default(NOTEBOOKS_PAGE_SIZE),
        archived: z.boolean().default(false),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { cursor, limit, archived } = input;

      const conditions = [eq(notebooks.archived, archived)];
      if (cursor) {
        conditions.push(lt(notebooks.updatedAt, new Date(cursor)));
      }

      const items = await ctx.db
        .select()
        .from(notebooks)
        .where(and(...conditions))
        .orderBy(desc(notebooks.updatedAt))
        .limit(limit + 1);

      const hasNextPage = items.length > limit;
      const resultItems = hasNextPage ? items.slice(0, limit) : items;
      const nextCursor = hasNextPage
        ? resultItems[resultItems.length - 1].updatedAt.toISOString()
        : undefined;

      return {
        items: resultItems,
        nextCursor,
      };
    }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().default(""),
        color: z.string().default("#6366f1"),
        icon: z.string().default("notebook"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const now = new Date();
      const id = `nb_${nanoid(12)}`;

      await ctx.db.insert(notebooks).values({
        id,
        name: input.name,
        description: input.description,
        color: input.color,
        icon: input.icon,
        fileCount: 0,
        archived: false,
        updatedAt: now,
        createdAt: now,
      });

      await writeNotebookTomlToR2(ctx.env.R2, id, {
        meta: {
          name: input.name,
          description: input.description,
          color: input.color,
          icon: input.icon,
          updated_at: now,
        },
        files: [],
      });

      const [created] = await ctx.db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, id));

      return created;
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input;

      const updateData: Record<string, unknown> = { ...fields };
      updateData.updatedAt = new Date();

      await ctx.db.update(notebooks).set(updateData).where(eq(notebooks.id, id));

      const metaUpdates: Record<string, unknown> = {};
      if (fields.name !== undefined) metaUpdates.name = fields.name;
      if (fields.description !== undefined) metaUpdates.description = fields.description;
      if (fields.color !== undefined) metaUpdates.color = fields.color;
      if (fields.icon !== undefined) metaUpdates.icon = fields.icon;
      if (Object.keys(metaUpdates).length > 0) {
        await updateNotebookMetaInR2(ctx.env.R2, id, metaUpdates as Parameters<typeof updateNotebookMetaInR2>[2]);
      }

      const [updated] = await ctx.db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, id));

      return updated;
    }),
});
