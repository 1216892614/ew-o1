import { z } from "zod";
import { applyPatch } from "diff";
import type { AnyTool } from "@tanstack/ai";
import { upsertNoteToAiSearch, searchNotebook } from "../utils/aiSearchSync";

function tool<TInput extends z.ZodType, TOutput extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  execute: (args: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}): AnyTool {
  return def as AnyTool;
}

interface CreateAgentToolsParams {
  env: Cloudflare.Env;
  notebookId: string;
  contentHashMap: Map<string, string>;
  askResolverRef: { current: { resolve: (v: unknown) => void } | null };
  finishFlagRef: { current: boolean };
  activeNoteIds: string[];
}

/* ── Shared helpers ─────────────────────────────────────── */

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function numberLines(content: string, startLine = 1): string {
  return content
    .split("\n")
    .map((line, i) => `${startLine + i}: ${line}`)
    .join("\n");
}

async function numberChunkLines(
  db: D1Database,
  noteId: string,
  chunkText: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT content FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ content: string }>();
  if (!row?.content) return chunkText;
  const clean = chunkText.replace(/\r/g, "");
  const idx = row.content.indexOf(clean);
  if (idx === -1) return chunkText;
  const startLine = row.content.slice(0, idx).split("\n").length;
  return numberLines(clean, startLine);
}

async function verifyHash(
  db: D1Database,
  fileId: string,
  contentHashMap: Map<string, string>,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const expected = contentHashMap.get(fileId);
  if (!expected) {
    return { ok: false, error: "File not read yet. Call read_file first." };
  }
  const row = await db
    .prepare("SELECT content FROM notes WHERE id = ?")
    .bind(fileId)
    .first<{ content: string }>();
  if (!row) {
    return { ok: false, error: "File not found." };
  }
  const actual = await sha256Hex(row.content ?? "");
  if (actual !== expected) {
    return { ok: false, error: "Content changed since last read. Re-read the file." };
  }
  return { ok: true, content: row.content ?? "" };
}

type SearchResult = {
  file_id: string;
  filename: string;
  summary: string;
  relevance?: number;
  type?: "file" | "category";
};

/* ── Tool factory ───────────────────────────────────────── */

export function createAgentTools(params: CreateAgentToolsParams) {
  const { env, notebookId, contentHashMap, askResolverRef, finishFlagRef, activeNoteIds } = params;
  const db = env.DB;

  /* ── Category queries ─────────────────────────────────── */

  async function listCategories(): Promise<SearchResult[]> {
    const cats = await db
      .prepare(
        `SELECT c.id, c.name,
           (SELECT COUNT(*) FROM notes n WHERE n.category_id = c.id AND n.archived = 0) AS file_count
         FROM categories c
         WHERE c.notebook_id = ? AND c.is_archive = 0
         ORDER BY c.position`,
      )
      .bind(notebookId)
      .all<{ id: string; name: string; file_count: number }>();
    return (cats.results ?? []).map((c) => ({
      file_id: c.id,
      filename: `${c.name}/`,
      summary: `分类，包含 ${c.file_count} 个文件`,
      type: "category" as const,
    }));
  }

  async function listCategoryFiles(catName: string): Promise<SearchResult[]> {
    const cat = await db
      .prepare("SELECT id FROM categories WHERE name = ? AND notebook_id = ?")
      .bind(catName, notebookId)
      .first<{ id: string }>();
    if (!cat) return [];
    const rows = await db
      .prepare(
        "SELECT id, name, content FROM notes WHERE category_id = ? AND notebook_id = ? AND archived = 0 ORDER BY position LIMIT 50",
      )
      .bind(cat.id, notebookId)
      .all<{ id: string; name: string; content: string }>();
    return (rows.results ?? []).map((r) => ({
      file_id: r.id,
      filename: r.name,
      summary: numberLines((r.content ?? "").split("\n").slice(0, 5).join("\n")),
      type: "file" as const,
    }));
  }

  async function matchCategories(query: string, limit = 5): Promise<SearchResult[]> {
    const cats = await db
      .prepare(
        `SELECT c.id, c.name,
           (SELECT COUNT(*) FROM notes n WHERE n.category_id = c.id AND n.archived = 0) AS file_count
         FROM categories c
         WHERE c.notebook_id = ? AND c.name LIKE ? AND c.is_archive = 0
         LIMIT ?`,
      )
      .bind(notebookId, `%${query}%`, limit)
      .all<{ id: string; name: string; file_count: number }>();
    return (cats.results ?? []).map((c) => ({
      file_id: c.id,
      filename: `${c.name}/`,
      summary: `分类，包含 ${c.file_count} 个文件`,
      type: "category" as const,
    }));
  }

  /* ── Note search ──────────────────────────────────────── */

  async function searchByName(query: string): Promise<SearchResult[]> {
    const [catResults, noteRows] = await Promise.all([
      matchCategories(query, 10),
      db
        .prepare(
          "SELECT id, name, content FROM notes WHERE notebook_id = ? AND name LIKE ? AND archived = 0 LIMIT 10",
        )
        .bind(notebookId, `%${query}%`)
        .all<{ id: string; name: string; content: string }>(),
    ]);
    const notes: SearchResult[] = (noteRows.results ?? []).map((r) => ({
      file_id: r.id,
      filename: r.name,
      summary: numberLines((r.content ?? "").split("\n").slice(0, 5).join("\n")),
      type: "file" as const,
    }));
    return [...catResults, ...notes];
  }

  async function searchByContent(query: string): Promise<SearchResult[]> {
    const catResults = await matchCategories(query);

    if (env.AI_SEARCH) {
      try {
        const chunks = await searchNotebook(env.AI_SEARCH, {
          notebookId,
          query,
          maxResults: 10,
          noteIds: activeNoteIds.length > 0 ? activeNoteIds : undefined,
        });
        if (chunks.length > 0) {
          const items = await Promise.all(
            chunks.map(async (chunk) => {
              const noteId = (chunk.item.metadata?.note_id as string) ?? chunk.item.key ?? "";
              const summary = await numberChunkLines(db, noteId, chunk.text.slice(0, 200));
              return {
                file_id: noteId,
                filename: (chunk.item.metadata?.filename as string) ?? chunk.item.key ?? "",
                summary,
                relevance: chunk.score,
                type: "file" as const,
              };
            }),
          );
          return [...catResults, ...items];
        }
      } catch {
        /* fall through to D1 */
      }
    }

    const rows = await db
      .prepare(
        "SELECT id, name, content FROM notes WHERE notebook_id = ? AND content LIKE ? AND archived = 0 LIMIT 10",
      )
      .bind(notebookId, `%${query}%`)
      .all<{ id: string; name: string; content: string }>();
    const notes: SearchResult[] = (rows.results ?? []).map((r) => ({
      file_id: r.id,
      filename: r.name,
      summary: numberLines((r.content ?? "").split("\n").slice(0, 5).join("\n")),
      type: "file" as const,
    }));
    return [...catResults, ...notes];
  }

  /* ── Tools array ──────────────────────────────────────── */

  const searchResultSchema = z.object({
    results: z.array(
      z.object({
        file_id: z.string(),
        filename: z.string(),
        summary: z.string(),
        relevance: z.number().optional(),
        type: z.enum(["file", "category"]).optional(),
      }),
    ),
  });

  return [
    tool({
      name: "search_file",
      description:
        "Search notebook notes and browse categories.\n" +
        "Category browsing:\n" +
        '  - query "*" or "" → list all category names.\n' +
        '  - query "分类名/" → list all files inside that category.\n' +
        "Search:\n" +
        "  - Default mode 'content': AI semantic search returning relevant chunks with line numbers and relevance score.\n" +
        "  - Mode 'name': filename lookup.\n" +
        "Results include files (type 'file') and categories (type 'category').",
      inputSchema: z.object({
        query: z.string().describe("Search query, category browse pattern, or keywords"),
        mode: z
          .enum(["content", "name"])
          .optional()
          .describe("Defaults to 'content' (AI semantic search). Use 'name' for filename lookup."),
      }),
      outputSchema: searchResultSchema,
      execute: async (args) => {
        const query = args.query.trim();

        if (query === "*" || query === "") {
          return { results: await listCategories() };
        }

        const catBrowse = query.match(/^(.+?)\/\*?$/);
        if (catBrowse) {
          return { results: await listCategoryFiles(catBrowse[1]) };
        }

        const mode = args.mode ?? "content";
        const results = mode === "name" ? await searchByName(query) : await searchByContent(query);
        return { results };
      },
    }),

    tool({
      name: "read_file",
      description:
        "Read file content by ID. Returns numbered lines. Without line range, returns the first 50 lines.",
      inputSchema: z.object({
        file_id: z.string().describe("File ID"),
        line_start: z.number().optional().describe("Start line (1-based)"),
        line_end: z.number().optional().describe("End line (inclusive)"),
      }),
      outputSchema: z.object({
        file_id: z.string(),
        filename: z.string(),
        total_lines: z.number(),
        content: z.string(),
      }),
      execute: async (args) => {
        const row = await db
          .prepare("SELECT id, name, content FROM notes WHERE id = ?")
          .bind(args.file_id)
          .first<{ id: string; name: string; content: string }>();
        if (!row) {
          return { file_id: args.file_id, filename: "NOT_FOUND", total_lines: 0, content: "" };
        }

        const fullContent = row.content ?? "";
        contentHashMap.set(args.file_id, await sha256Hex(fullContent));

        const lines = fullContent.split("\n");
        const total = lines.length;
        const MAX_SPAN = 200;

        let start: number;
        let end: number;
        if (args.line_start === undefined) {
          start = 0;
          end = Math.min(50, total);
        } else {
          start = Math.max(0, args.line_start - 1);
          end = args.line_end !== undefined ? Math.min(args.line_end, total) : Math.min(start + MAX_SPAN, total);
        }
        if (end - start > MAX_SPAN) end = start + MAX_SPAN;

        return {
          file_id: row.id,
          filename: row.name,
          total_lines: total,
          content: numberLines(lines.slice(start, end).join("\n"), start + 1),
        };
      },
    }),

    tool({
      name: "edit_file",
      description:
        "Rename a file or change its category. Requires a prior read_file call.\n" +
        'new_tag: category name/ID to move to. "Archived" = archive. Omit = no change.',
      inputSchema: z.object({
        file_id: z.string(),
        new_filename: z.string().optional(),
        new_tag: z.string().optional(),
      }),
      outputSchema: z.object({ success: z.boolean(), file_id: z.string(), error: z.string().optional() }),
      execute: async (args) => {
        const check = await verifyHash(db, args.file_id, contentHashMap);
        if (!check.ok) return { success: false, file_id: args.file_id, error: check.error };

        if (args.new_filename) {
          await db.prepare("UPDATE notes SET name = ? WHERE id = ?").bind(args.new_filename, args.file_id).run();
        }

        if (args.new_tag) {
          if (args.new_tag === "Archived") {
            await db.prepare("UPDATE notes SET category_id = NULL WHERE id = ?").bind(args.file_id).run();
          } else {
            let category = await db
              .prepare("SELECT id FROM categories WHERE (name = ? OR id = ?) AND notebook_id = ?")
              .bind(args.new_tag, args.new_tag, notebookId)
              .first<{ id: string }>();

            if (!category) {
              const newCatId = crypto.randomUUID();
              const maxPos = await db
                .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM categories WHERE notebook_id = ?")
                .bind(notebookId)
                .first<{ next_pos: number }>();
              await db
                .prepare("INSERT INTO categories (id, notebook_id, name, position, is_archive) VALUES (?, ?, ?, ?, 0)")
                .bind(newCatId, notebookId, args.new_tag, maxPos?.next_pos ?? 0)
                .run();
              category = { id: newCatId };
            }

            await db.prepare("UPDATE notes SET category_id = ? WHERE id = ?").bind(category.id, args.file_id).run();
          }
        }

        if (args.new_filename && env.AI_SEARCH) {
          const meta = await db
            .prepare("SELECT name, content, notebook_id FROM notes WHERE id = ?")
            .bind(args.file_id)
            .first<{ name: string; content: string; notebook_id: string }>();
          if (meta) {
            upsertNoteToAiSearch(env.AI_SEARCH, {
              notebookId: meta.notebook_id,
              noteId: args.file_id,
              filename: meta.name,
              content: meta.content ?? "",
            }).catch(() => {});
          }
        }

        return { success: true, file_id: args.file_id };
      },
    }),

    tool({
      name: "edit_content",
      description: [
        "Apply a unified diff patch to file content. Requires a prior read_file call.",
        "The `diff` field must be a valid unified diff string (the format produced by `diff -u` / `git diff`).",
        "Omit the `--- a/` and `+++ b/` file headers — only hunks are needed.",
        "Example diff value:",
        "@@ -2,3 +2,4 @@",
        " existing context line",
        "-old line to remove",
        "+new replacement line",
        "+another new line",
        " more context",
      ].join("\n"),
      inputSchema: z.object({
        file_id: z.string(),
        diff: z.string().describe("Unified diff patch (hunks only, no file headers)"),
      }),
      outputSchema: z.object({ success: z.boolean(), file_id: z.string(), error: z.string().optional() }),
      execute: async (args) => {
        const check = await verifyHash(db, args.file_id, contentHashMap);
        if (!check.ok) return { success: false, file_id: args.file_id, error: check.error };

        const patchText = [
          "--- a/file",
          "+++ b/file",
          args.diff,
        ].join("\n");

        const result = applyPatch(check.content, patchText, { fuzzFactor: 2 });
        if (result === false) {
          return {
            success: false,
            file_id: args.file_id,
            error: "Diff patch failed to apply. Context lines may not match current content. Re-read the file with read_file and try again.",
          };
        }

        const newContent = result;
        const wordCount = newContent.split(/\s+/).filter(Boolean).length;
        const now = new Date().toISOString();
        contentHashMap.set(args.file_id, await sha256Hex(newContent));

        await db
          .prepare("UPDATE notes SET content = ?, word_count = ?, updated_at = ? WHERE id = ?")
          .bind(newContent, wordCount, now, args.file_id)
          .run();

        if (env.AI_SEARCH) {
          const meta = await db
            .prepare("SELECT name, notebook_id FROM notes WHERE id = ?")
            .bind(args.file_id)
            .first<{ name: string; notebook_id: string }>();
          if (meta) {
            upsertNoteToAiSearch(env.AI_SEARCH, {
              notebookId: meta.notebook_id,
              noteId: args.file_id,
              filename: meta.name,
              content: newContent,
            }).catch(() => {});
          }
        }

        return { success: true, file_id: args.file_id };
      },
    }),

    tool({
      name: "web_search",
      description: "Search the web. (Not yet implemented.)",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) }),
      execute: async () => ({ results: [] }),
    }),

    tool({
      name: "web_page_read",
      description: "Read a web page as markdown. (Not yet implemented.)",
      inputSchema: z.object({ url: z.string() }),
      outputSchema: z.object({ title: z.string(), content: z.string() }),
      execute: async () => ({ title: "Not implemented", content: "Browser rendering not yet wired." }),
    }),

    tool({
      name: "reply",
      description: "Send a progress message to the user without pausing the loop.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ success: z.boolean() }),
      execute: async () => ({ success: true }),
    }),

    tool({
      name: "ask",
      description: "Ask the user questions and wait for answers. Pauses the agent loop.",
      inputSchema: z.object({
        questions: z.array(
          z.object({
            id: z.string(),
            question: z.string(),
            options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
            multi: z.boolean().optional(),
          }),
        ),
      }),
      outputSchema: z.object({ answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])) }),
      execute: async () =>
        new Promise<{ answers: Record<string, string | string[]> }>((resolve) => {
          askResolverRef.current = { resolve: resolve as (v: unknown) => void };
        }),
    }),

    tool({
      name: "finish",
      description: "Signal task complete. Terminates the agent loop.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ success: z.boolean() }),
      execute: async () => {
        finishFlagRef.current = true;
        return { success: true };
      },
    }),
  ];
}

export { numberChunkLines };
