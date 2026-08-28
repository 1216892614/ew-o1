import { z } from "zod";
import { notebooks } from "@lib/db";
import { desc, lt, and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";

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

      const [updated] = await ctx.db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, id));

      return updated;
    }),
});
