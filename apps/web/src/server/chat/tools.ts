import { z } from "zod";
import type { AnyTool } from "@tanstack/ai";

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
}

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

export function createAgentTools(params: CreateAgentToolsParams) {
  const { env, notebookId, contentHashMap, askResolverRef, finishFlagRef } = params;

  return [
    tool({
      name: "search_file",
      description:
        "Search for files in the notebook by name or content. Use 'name' mode to find files by filename, 'content' mode to search within file contents.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        mode: z.enum(["content", "name"]).optional().describe("Search mode: 'name' for filename search, 'content' for full-text search. Defaults to content."),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            file_id: z.string(),
            filename: z.string(),
            summary: z.string(),
            relevance: z.number().optional(),
          }),
        ),
      }),
      execute: async (args) => {
        const mode = args.mode ?? "content";

        if (mode === "name") {
          const rows = await env.DB.prepare(
            "SELECT id, name, content FROM notes WHERE notebook_id = ? AND name LIKE ? AND archived = 0 LIMIT 10",
          )
            .bind(notebookId, `%${args.query}%`)
            .all<{ id: string; name: string; content: string }>();

          return {
            results: (rows.results ?? []).map((r) => ({
              file_id: r.id,
              filename: r.name,
              summary: (r.content ?? "").slice(0, 100),
            })),
          };
        }

        if (env.AI_SEARCH) {
          try {
            const instance = env.AI_SEARCH.get(notebookId);
            const searchResults = await instance.search({
              messages: [{ role: "user", content: args.query }],
              ai_search_options: {
                retrieval: { retrieval_type: "hybrid", max_num_results: 10 },
              },
            });
            if (searchResults.chunks && searchResults.chunks.length > 0) {
              return {
                results: searchResults.chunks.map((chunk) => ({
                  file_id: ((chunk.item.metadata?.id as string) ?? chunk.item.key ?? ""),
                  filename: ((chunk.item.metadata?.name as string) ?? chunk.item.key ?? ""),
                  summary: chunk.text.slice(0, 200),
                  relevance: chunk.score,
                })),
              };
            }
          } catch {
            // Fall through to D1 fallback
          }
        }

        const rows = await env.DB.prepare(
          "SELECT id, name, content FROM notes WHERE notebook_id = ? AND content LIKE ? AND archived = 0 LIMIT 10",
        )
          .bind(notebookId, `%${args.query}%`)
          .all<{ id: string; name: string; content: string }>();

        return {
          results: (rows.results ?? []).map((r) => ({
            file_id: r.id,
            filename: r.name,
            summary: (r.content ?? "").slice(0, 100),
          })),
        };
      },
    }),

    tool({
      name: "read_file",
      description:
        "Read the content of a file by its ID. Returns numbered lines. If no line range is specified, returns the first 50 lines.",
      inputSchema: z.object({
        file_id: z.string().describe("The file ID to read"),
        line_start: z.number().optional().describe("Starting line number (1-based)"),
        line_end: z.number().optional().describe("Ending line number (inclusive)"),
      }),
      outputSchema: z.object({
        file_id: z.string(),
        filename: z.string(),
        total_lines: z.number(),
        content: z.string(),
      }),
      execute: async (args) => {
        const row = await env.DB.prepare("SELECT id, name, content FROM notes WHERE id = ?")
          .bind(args.file_id)
          .first<{ id: string; name: string; content: string }>();

        if (!row) {
          return { file_id: args.file_id, filename: "NOT_FOUND", total_lines: 0, content: "" };
        }

        const fullContent = row.content ?? "";
        const hash = await sha256Hex(fullContent);
        contentHashMap.set(args.file_id, hash);

        const lines = fullContent.split("\n");
        const totalLines = lines.length;

        let start: number;
        let end: number;

        if (args.line_start === undefined) {
          start = 0;
          end = Math.min(50, totalLines);
        } else {
          start = Math.max(0, args.line_start - 1);
          end = args.line_end !== undefined ? Math.min(args.line_end, totalLines) : Math.min(start + 200, totalLines);
        }

        const maxSpan = 200;
        if (end - start > maxSpan) {
          end = start + maxSpan;
        }

        const numbered = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`);

        return {
          file_id: row.id,
          filename: row.name,
          total_lines: totalLines,
          content: numbered.join("\n"),
        };
      },
    }),

    tool({
      name: "edit_file",
      description: "Rename a file or change its category/tag. Set new_tag to null to archive (remove from category). Requires a prior read_file call to establish content hash.",
      inputSchema: z.object({
        file_id: z.string().describe("The file ID to edit"),
        new_filename: z.string().optional().describe("New filename"),
        new_tag: z.string().nullable().optional().describe("New category/tag name or ID. Set to null to archive (remove from any category)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        file_id: z.string(),
        error: z.string().optional(),
      }),
      execute: async (args) => {
        const existingHash = contentHashMap.get(args.file_id);
        if (!existingHash) {
          return { success: false, file_id: args.file_id, error: "File not read yet. Call read_file first." };
        }

        const row = await env.DB.prepare("SELECT content FROM notes WHERE id = ?")
          .bind(args.file_id)
          .first<{ content: string }>();

        if (!row) {
          return { success: false, file_id: args.file_id, error: "File not found." };
        }

        const currentHash = await sha256Hex(row.content ?? "");
        if (currentHash !== existingHash) {
          return { success: false, file_id: args.file_id, error: "Content changed since last read. Re-read the file." };
        }

        if (args.new_filename) {
          await env.DB.prepare("UPDATE notes SET name = ? WHERE id = ?")
            .bind(args.new_filename, args.file_id)
            .run();
        }

        if (args.new_tag !== undefined) {
          if (args.new_tag === null) {
            await env.DB.prepare("UPDATE notes SET category_id = NULL WHERE id = ?")
              .bind(args.file_id)
              .run();
          } else {
            const category = await env.DB.prepare(
              "SELECT id FROM categories WHERE name = ? AND notebook_id = ?",
            )
              .bind(args.new_tag, notebookId)
              .first<{ id: string }>();

            const categoryId = category?.id ?? args.new_tag;
            await env.DB.prepare("UPDATE notes SET category_id = ? WHERE id = ?")
              .bind(categoryId, args.file_id)
              .run();
          }
        }

        return { success: true, file_id: args.file_id };
      },
    }),

    tool({
      name: "edit_content",
      description:
        "Apply line-based patches to a file's content. Each patch replaces lines from start_line to end_line (inclusive, 1-based) with new content. Requires a prior read_file call.",
      inputSchema: z.object({
        file_id: z.string().describe("The file ID to patch"),
        patches: z.array(
          z.object({
            start_line: z.number().describe("First line to replace (1-based, inclusive)"),
            end_line: z.number().describe("Last line to replace (1-based, inclusive)"),
            content: z.string().describe("Replacement content (may contain newlines)"),
          }),
        ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        file_id: z.string(),
        error: z.string().optional(),
      }),
      execute: async (args) => {
        const existingHash = contentHashMap.get(args.file_id);
        if (!existingHash) {
          return { success: false, file_id: args.file_id, error: "File not read yet. Call read_file first." };
        }

        const row = await env.DB.prepare("SELECT content FROM notes WHERE id = ?")
          .bind(args.file_id)
          .first<{ content: string }>();

        if (!row) {
          return { success: false, file_id: args.file_id, error: "File not found." };
        }

        const currentHash = await sha256Hex(row.content ?? "");
        if (currentHash !== existingHash) {
          return { success: false, file_id: args.file_id, error: "Content changed since last read. Re-read the file." };
        }

        const lines = (row.content ?? "").split("\n");

        const sortedPatches = [...args.patches].sort((a, b) => b.start_line - a.start_line);
        for (const patch of sortedPatches) {
          const start = Math.max(0, patch.start_line - 1);
          const end = Math.min(lines.length, patch.end_line);
          const replacement = patch.content.split("\n");
          lines.splice(start, end - start, ...replacement);
        }

        const newContent = lines.join("\n");
        const wordCount = newContent.split(/\s+/).filter(Boolean).length;
        const now = new Date().toISOString();
        const newHash = await sha256Hex(newContent);

        await env.DB.prepare(
          "UPDATE notes SET content = ?, word_count = ?, updated_at = ? WHERE id = ?",
        )
          .bind(newContent, wordCount, now, args.file_id)
          .run();

        contentHashMap.set(args.file_id, newHash);

        return { success: true, file_id: args.file_id };
      },
    }),

    tool({
      name: "web_search",
      description: "Search the web for information. Currently returns empty results (not yet implemented).",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            title: z.string(),
            url: z.string(),
            snippet: z.string(),
          }),
        ),
      }),
      execute: async () => {
        return { results: [] };
      },
    }),

    tool({
      name: "web_page_read",
      description: "Read and extract content from a web page URL. Currently a stub.",
      inputSchema: z.object({
        url: z.string().describe("URL to read"),
      }),
      outputSchema: z.object({
        title: z.string(),
        content: z.string(),
      }),
      execute: async () => {
        return { title: "Not implemented", content: "Browser rendering not yet wired." };
      },
    }),

    tool({
      name: "reply",
      description: "Send a progress message to the user without expecting a response. Use this to communicate intermediate steps or status updates.",
      inputSchema: z.object({
        message: z.string().describe("Progress message to display to the user"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
      }),
      execute: async () => {
        return { success: true };
      },
    }),

    tool({
      name: "ask",
      description:
        "Ask the user one or more questions and wait for their response. The agent loop will pause until the user answers.",
      inputSchema: z.object({
        questions: z.array(
          z.object({
            id: z.string().describe("Unique question identifier"),
            question: z.string().describe("The question text"),
            options: z.array(
              z.object({
                label: z.string().describe("Option label"),
                description: z.string().optional().describe("Option description"),
              }),
            ),
            multi: z.boolean().optional().describe("Whether multiple selections are allowed"),
          }),
        ),
      }),
      outputSchema: z.object({
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      }),
      execute: async () => {
        return new Promise<{ answers: Record<string, string | string[]> }>((resolve) => {
          askResolverRef.current = { resolve: resolve as (v: unknown) => void };
        });
      },
    }),

    tool({
      name: "finish",
      description:
        "Signal that the task is complete and the agent loop should terminate. Include a final summary message.",
      inputSchema: z.object({
        message: z.string().describe("Final completion message"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
      }),
      execute: async () => {
        finishFlagRef.current = true;
        return { success: true };
      },
    }),
  ];
}
