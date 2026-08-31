import { Hono } from "hono";
import type { HonoCtxEnv } from "@/shared/types";
import { readNotebookTomlFromR2 } from "./utils/r2Sync";
import type { ShareKVValue } from "./trpc/routers/share";

export const shareRoute = new Hono<HonoCtxEnv>();

// ── Helpers ──────────────────────────────────────────────────

async function validateShare(
  kv: KVNamespace,
  notebookId: string,
  code: string | null,
): Promise<ShareKVValue | null> {
  if (!code) return null;
  const raw = await kv.get(`share:${notebookId}`, "text");
  if (!raw) return null;
  const val: ShareKVValue = JSON.parse(raw);
  if (val.expiresAt > 0 && Date.now() > val.expiresAt) {
    await kv.delete(`share:${notebookId}`);
    return null;
  }
  if (val.code !== code) return null;
  return val;
}

function noteR2Key(notebookId: string, filename: string): string {
  return `docs/${notebookId}/${filename}`;
}

// ── Public APIs (LLM-friendly, code-authenticated, no ZeroTrust) ──

/**
 * GET /notebook/s/:notebookId?code=xxx
 *
 * Directory listing sourced from ew-o1.toml on R2.
 * Hidden tags are filtered out. Each file includes a ready-to-use URL.
 */
shareRoute.get("/notebook/s/:notebookId", async (c) => {
  const notebookId = c.req.param("notebookId");
  const code = c.req.query("code") ?? null;

  const share = await validateShare(c.env.SHARE_KV, notebookId, code);
  if (!share) return c.json({ error: "Invalid or expired share link" }, 403);

  const toml = await readNotebookTomlFromR2(c.env.R2, notebookId);
  const hiddenSet = new Set(share.hiddenTags);
  const hideArchived = hiddenSet.has("__archived__");

  const baseUrl = new URL(c.req.url);
  const origin = `${baseUrl.protocol}//${baseUrl.host}`;

  const files = toml.files
    .filter((f) => {
      if (!f.tag) return !hideArchived;
      return !hiddenSet.has(f.tag);
    })
    .map((f) => ({
      id: f.id,
      filename: f.filename,
      tag: f.tag || null,
      url: `${origin}/notebook/s/${notebookId}/${f.id}?code=${share.code}`,
    }));

  return c.json({
    notebook: {
      name: toml.meta.name,
      description: toml.meta.description,
    },
    fileCount: files.length,
    files,
  });
});

/**
 * GET /notebook/s/:notebookId/:noteId?code=xxx
 *
 * Returns the raw markdown content of a single note, read from R2.
 */
shareRoute.get("/notebook/s/:notebookId/:noteId", async (c) => {
  const notebookId = c.req.param("notebookId");
  const noteId = c.req.param("noteId");
  const code = c.req.query("code") ?? null;

  const share = await validateShare(c.env.SHARE_KV, notebookId, code);
  if (!share) return c.json({ error: "Invalid or expired share link" }, 403);

  const toml = await readNotebookTomlFromR2(c.env.R2, notebookId);
  const file = toml.files.find((f) => f.id === noteId);

  if (!file) return c.json({ error: "Note not found" }, 404);

  const hidden = file.tag
    ? share.hiddenTags.includes(file.tag)
    : share.hiddenTags.includes("__archived__");
  if (hidden) {
    return c.json({ error: "Note is hidden" }, 403);
  }

  const obj = await c.env.R2.get(noteR2Key(notebookId, file.filename));
  const content = obj ? await obj.text() : "";

  return c.json({
    id: file.id,
    filename: file.filename,
    tag: file.tag || null,
    content,
  });
});
