import { z } from "zod";
import { nanoid } from "nanoid";
import { publicProcedure, router } from "../init";
import { readNotebookTomlFromR2 } from "../../utils/r2Sync";

/**
 * KV value schema for a share link.
 * Key: `share:<notebookId>`
 */
export interface ShareKVValue {
  code: string;
  /** Hidden tag names (from ew-o1.toml [[files]] tag field) */
  hiddenTags: string[];
  /** Epoch ms — 0 = never expires */
  expiresAt: number;
  createdAt: number;
}

async function getShare(
  kv: KVNamespace,
  notebookId: string,
): Promise<ShareKVValue | null> {
  const raw = await kv.get(`share:${notebookId}`, "text");
  if (!raw) return null;
  const val: ShareKVValue = JSON.parse(raw);
  if (val.expiresAt > 0 && Date.now() > val.expiresAt) {
    await kv.delete(`share:${notebookId}`);
    return null;
  }
  return val;
}

export const shareRouter = router({
  /** Get current share settings + all tags from toml. */
  get: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .query(async ({ input, ctx }) => {
      const share = await getShare(ctx.env.SHARE_KV, input.notebookId);
      const toml = await readNotebookTomlFromR2(ctx.env.R2, input.notebookId);
      const tagSet = new Set(toml.files.map((f) => f.tag).filter(Boolean));
      const tags = [...tagSet];
      // Files with empty tag are "archived" — surface as a virtual tag
      const hasArchived = toml.files.some((f) => !f.tag);
      if (hasArchived) tags.push("__archived__");
      return { share, tags };
    }),

  /** Create or update share link. */
  upsert: publicProcedure
    .input(
      z.object({
        notebookId: z.string(),
        hiddenTags: z.array(z.string()),
        ttlSeconds: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await getShare(ctx.env.SHARE_KV, input.notebookId);
      const code = existing?.code ?? nanoid(16);

      const expiresAt =
        input.ttlSeconds > 0 ? Date.now() + input.ttlSeconds * 1000 : 0;

      const val: ShareKVValue = {
        code,
        hiddenTags: input.hiddenTags,
        expiresAt,
        createdAt: existing?.createdAt ?? Date.now(),
      };

      const kvOpts: KVNamespacePutOptions =
        input.ttlSeconds > 0 ? { expirationTtl: input.ttlSeconds } : {};

      await ctx.env.SHARE_KV.put(
        `share:${input.notebookId}`,
        JSON.stringify(val),
        kvOpts,
      );
      return val;
    }),

  /** Regenerate the share code (old link becomes invalid). */
  refreshCode: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const share = await getShare(ctx.env.SHARE_KV, input.notebookId);
      if (!share) throw new Error("No share link exists for this notebook");

      share.code = nanoid(16);

      const kvOpts: KVNamespacePutOptions = {};
      if (share.expiresAt > 0) {
        const remaining = Math.max(
          60,
          Math.floor((share.expiresAt - Date.now()) / 1000),
        );
        kvOpts.expirationTtl = remaining;
      }

      await ctx.env.SHARE_KV.put(
        `share:${input.notebookId}`,
        JSON.stringify(share),
        kvOpts,
      );
      return share;
    }),

  /** Delete the share link entirely. */
  delete: publicProcedure
    .input(z.object({ notebookId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.env.SHARE_KV.delete(`share:${input.notebookId}`);
      return { ok: true };
    }),
});
