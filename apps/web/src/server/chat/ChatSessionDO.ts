import { DurableObject } from "cloudflare:workers";
import { chat, maxIterations, toServerSentEventsResponse, toolDefinition, type StreamChunk } from "@tanstack/ai";
import { OpenAIChatCompletionsTextAdapter } from "@tanstack/ai-openai";
import { z } from "zod";
import type {
  ChatNode,
  UserNode,
  AssistantNode,
  TimelineEntry,
  ThinkingEntry,
  ToolCallEntry,
  ChatRequestBody,
  ChatMessagesResponse,
} from "@/shared/chat-types";
import { resolvePathToLeaf, findLatestLeaf } from "@/shared/chat-types";

/* ── Persisted row shape in DO SQLite ──────────────────── */

interface NodeRow {
  id: string;
  role: string;
  parentId: string | null;
  content: string;
  timeline: string | null;
  model: string | null;
  modelName: string | null;
  modelProvider: string | null;
  modelParams: string | null;
  status: string | null;
  createdAt: number;
}

/* ── Durable Object ────────────────────────────────────── */

export class ChatSessionDO extends DurableObject<Cloudflare.Env> {
  private notebookId = "";
  private sessionId = "";

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          parent_id TEXT,
          content TEXT NOT NULL DEFAULT '',
          timeline TEXT,
          model TEXT,
          model_name TEXT,
          model_provider TEXT,
          model_params TEXT,
          status TEXT,
          created_at INTEGER NOT NULL
        )
      `);

      /* ── Migration: old flat "messages" table → tree "nodes" ── */
      const hasOldTable =
        this.ctx.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
          .toArray().length > 0;

      if (hasOldTable) {
        const oldRows = this.ctx.storage.sql
          .exec<{
            id: string;
            role: string;
            content: string;
            timeline: string | null;
            model_name: string | null;
            model_provider: string | null;
            created_at: number;
          }>("SELECT id, role, content, timeline, model_name, model_provider, created_at FROM messages ORDER BY created_at ASC")
          .toArray();

        if (oldRows.length > 0) {
          let lastUserNodeId: string | null = null;
          let lastAssistantNodeId: string | null = null;

          for (const row of oldRows) {
            const parentId = row.role === "user" ? lastAssistantNodeId : lastUserNodeId;
            const status = row.role === "assistant" ? "done" : null;

            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id,
              row.role,
              parentId,
              row.content,
              row.timeline,
              null,
              row.model_name,
              row.model_provider,
              null,
              status,
              row.created_at,
            );

            if (row.role === "user") lastUserNodeId = row.id;
            if (row.role === "assistant") lastAssistantNodeId = row.id;
          }
        }

        this.ctx.storage.sql.exec("DROP TABLE messages");
      }
    });
  }

  /** Set session identity from route key (notebookId/sessionId) */
  setSessionKey(key: string) {
    const parts = key.split("/");
    this.notebookId = parts[0] ?? "";
    this.sessionId = parts[1] ?? "";
  }

  async getMessages(): Promise<ChatMessagesResponse> {
    const rows = this.ctx.storage.sql
      .exec<NodeRow>(
        `SELECT id, role, parent_id as parentId, content, timeline, model, model_name as modelName,
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt
         FROM nodes ORDER BY created_at ASC`,
      )
      .toArray();

    const nodes = rows.map(rowToNode);
    const leafId = findLatestLeaf(nodes);
    return { nodes, leafId };
  }

  async chat(request: Request): Promise<Response> {
    const body = (await request.json()) as ChatRequestBody;

    this.notebookId = body.notebookId;
    this.sessionId = body.sessionId;

    const userNodeId = nanoid();
    const now = Date.now();

    const userNode: UserNode = {
      id: userNodeId,
      role: "user",
      parentId: body.parentId,
      content: body.message,
      model: body.model,
      modelName: body.modelName ?? body.model,
      modelProvider: body.modelProvider ?? "",
      modelParams: body.modelParams ?? null,
      createdAt: now,
    };

    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userNode.id,
      userNode.role,
      userNode.parentId,
      userNode.content,
      null,
      userNode.model,
      userNode.modelName,
      userNode.modelProvider,
      userNode.modelParams ? JSON.stringify(userNode.modelParams) : null,
      null,
      userNode.createdAt,
    );

    /* Build the message path from root to this user node for LLM context */
    const allRows = this.ctx.storage.sql
      .exec<NodeRow>(
        `SELECT id, role, parent_id as parentId, content, timeline, model, model_name as modelName,
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt
         FROM nodes ORDER BY created_at ASC`,
      )
      .toArray();
    const allNodes = allRows.map(rowToNode);

    const pathToUser = resolvePathToLeaf(allNodes, userNodeId);
    const llmMessages = pathToUser.map((n) => ({
      role: n.role as "user" | "assistant",
      content: n.content,
    }));

    const systemPrompts: string[] = [];
    if (body.systemPrompt) {
      systemPrompts.push(body.systemPrompt);
    }
    if (body.activeNotes && body.activeNotes.length > 0) {
      const notesContext = body.activeNotes.map((n) => `## ${n.name}\n${n.content}`).join("\n\n---\n\n");
      systemPrompts.push(
        `You have access to the following notes from the user's notebook. Reference them when relevant:\n\n${notesContext}`,
      );
    }

    const adapter = this.createAdapter(body.model);

    const tools = [
      toolDefinition({
        name: "search_notes",
        description: "Search through the user's active notes by keyword",
        input: z.object({
          query: z.string().describe("Search query"),
        }),
        output: z.object({
          results: z.array(
            z.object({
              name: z.string(),
              snippet: z.string(),
            }),
          ),
        }),
        execute: async ({ input }) => {
          const notes = body.activeNotes ?? [];
          const queryLower = input.query.toLowerCase();
          const results = notes
            .filter(
              (n) =>
                n.name.toLowerCase().includes(queryLower) || n.content.toLowerCase().includes(queryLower),
            )
            .map((n) => {
              const idx = n.content.toLowerCase().indexOf(queryLower);
              const start = Math.max(0, idx - 50);
              const end = Math.min(n.content.length, idx + input.query.length + 50);
              return {
                name: n.name,
                snippet: idx >= 0 ? n.content.slice(start, end) : n.content.slice(0, 100),
              };
            });
          return { results };
        },
      }),
    ];

    const modelOptions: Record<string, unknown> = {};
    if (body.modelParams?.temperature !== undefined) {
      modelOptions.temperature = body.modelParams.temperature;
    }
    if (body.modelParams?.topP !== undefined) {
      modelOptions.top_p = body.modelParams.topP;
    }
    if (body.modelParams?.maxPerRound !== undefined) {
      modelOptions.max_output_tokens = body.modelParams.maxPerRound;
    }
    if (body.modelParams?.thinkingLevel !== undefined) {
      modelOptions.reasoning = { effort: body.modelParams.thinkingLevel };
    }

    const stream = chat({
      adapter,
      messages: llmMessages,
      systemPrompts: systemPrompts.length > 0 ? systemPrompts : undefined,
      tools,
      agentLoopStrategy: maxIterations(5),
      modelOptions: modelOptions as never,
    });

    const assistantNodeId = nanoid();
    const teedStream = this.teeAndPersistAssistantResponse(
      stream,
      assistantNodeId,
      userNodeId,
      body.modelName ?? body.model,
      body.modelProvider ?? "",
      body.model,
    );

    return toServerSentEventsResponse(teedStream, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-User-Node-Id, X-Assistant-Node-Id",
        "Cache-Control": "no-cache",
        "X-User-Node-Id": userNodeId,
        "X-Assistant-Node-Id": assistantNodeId,
      },
    });
  }

  private createAdapter(model: string) {
    const isDeepseek = model.startsWith("deepseek");
    const apiKey = isDeepseek ? this.env.DEEPSEEK_AI_KEY : this.env.BIGBIGDOG_AI_KEY;
    const baseURL = isDeepseek
      ? `https://gateway.ai.cloudflare.com/v1/3244c8f91cd34317ce18652158e5853a/${this.env.CF_AI_GATEWAY_ID}/deepseek`
      : "https://www.dogapi.cc/v1";

    return new ReasoningChatCompletionsAdapter({ apiKey, baseURL }, model as never);
  }

  /**
   * Tee the SSE stream: yield each chunk to the client AND collect
   * a full timeline array to persist as one assistant node.
   * After stream ends → persist to DO SQLite + flush to R2.
   */
  private async *teeAndPersistAssistantResponse(
    stream: AsyncIterable<StreamChunk>,
    assistantNodeId: string,
    userNodeId: string,
    modelName: string,
    modelProvider: string,
    model: string,
  ): AsyncIterable<StreamChunk> {
    const timeline: TimelineEntry[] = [];
    const contentParts: string[] = [];

    for await (const chunk of stream) {
      const type = chunk.type as string;

      switch (type) {
        case "THINKING_START":
        case "REASONING_START": {
          timeline.push({ kind: "thinking", content: "", done: false });
          break;
        }
        case "THINKING_TEXT_MESSAGE_CONTENT":
        case "REASONING_MESSAGE_CONTENT": {
          const delta = ((chunk as Record<string, unknown>).delta ?? "") as string;
          const last = findLast(timeline, "thinking") as ThinkingEntry | undefined;
          if (last) last.content += delta;
          else timeline.push({ kind: "thinking", content: delta, done: false });
          break;
        }
        case "THINKING_END":
        case "REASONING_END": {
          const last = findLast(timeline, "thinking") as ThinkingEntry | undefined;
          if (last) last.done = true;
          break;
        }

        case "TOOL_CALL_START": {
          const c = chunk as Record<string, unknown>;
          timeline.push({
            kind: "tool_call",
            toolCallId: (c.toolCallId ?? "") as string,
            name: ((c.toolCallName ?? c.toolName ?? "tool") as string),
            args: "",
            done: false,
          });
          break;
        }
        case "TOOL_CALL_ARGS": {
          const c = chunk as Record<string, unknown>;
          const tcId = c.toolCallId as string;
          const entry = timeline.find(
            (e) => e.kind === "tool_call" && e.toolCallId === tcId,
          ) as ToolCallEntry | undefined;
          if (entry) entry.args += (c.delta ?? "") as string;
          break;
        }
        case "TOOL_CALL_END": {
          const c = chunk as Record<string, unknown>;
          const tcId = c.toolCallId as string;
          const entry = timeline.find(
            (e) => e.kind === "tool_call" && e.toolCallId === tcId,
          ) as ToolCallEntry | undefined;
          if (entry) {
            entry.done = true;
            if (c.result != null) entry.result = JSON.stringify(c.result);
          }
          break;
        }
        case "TOOL_CALL_RESULT": {
          const c = chunk as Record<string, unknown>;
          const tcId = c.toolCallId as string;
          const entry = timeline.find(
            (e) => e.kind === "tool_call" && e.toolCallId === tcId,
          ) as ToolCallEntry | undefined;
          if (entry) {
            entry.done = true;
            entry.result = ((c.content ?? c.result ?? "") as string);
          }
          break;
        }

        case "TEXT_MESSAGE_START": {
          timeline.push({ kind: "text", content: "", streaming: false });
          break;
        }
        case "TEXT_MESSAGE_CONTENT": {
          const delta = ((chunk as Record<string, unknown>).delta ?? "") as string;
          contentParts.push(delta);
          const last = timeline[timeline.length - 1];
          if (last?.kind === "text") {
            last.content += delta;
          } else {
            timeline.push({ kind: "text", content: delta, streaming: false });
          }
          break;
        }
        case "TEXT_MESSAGE_END":
          break;
        default:
          break;
      }

      yield chunk;
    }

    /* Persist assistant node to DO SQLite */
    const fullContent = contentParts.join("");
    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assistantNodeId,
      "assistant",
      userNodeId,
      fullContent,
      JSON.stringify(timeline),
      model,
      modelName,
      modelProvider,
      null,
      "done",
      Date.now(),
    );

    /* Flush entire session to R2 */
    await this.flushToR2();
  }

  /** Serialize all nodes to JSONL and write to R2 */
  private async flushToR2() {
    if (!this.notebookId || !this.sessionId) return;

    const rows = this.ctx.storage.sql
      .exec<NodeRow>(
        `SELECT id, role, parent_id as parentId, content, timeline, model, model_name as modelName,
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt
         FROM nodes ORDER BY created_at ASC`,
      )
      .toArray();

    const lines = rows.map((row) => JSON.stringify(row));
    const jsonl = lines.join("\n") + "\n";
    const r2Key = `docs/${this.notebookId}/.chat/${this.sessionId}.jsonl`;

    await this.env.R2.put(r2Key, jsonl);
  }
}

/* ── Helpers ────────────────────────────────────────────── */

function rowToNode(row: NodeRow): ChatNode {
  if (row.role === "assistant") {
    let timeline: TimelineEntry[] = [];
    if (row.timeline) {
      try {
        timeline = JSON.parse(row.timeline);
      } catch {
        timeline = row.content
          ? [{ kind: "text", content: row.content, streaming: false }]
          : [];
      }
    }
    return {
      id: row.id,
      role: "assistant",
      parentId: row.parentId ?? "",
      content: row.content,
      timeline,
      model: row.model ?? "",
      modelName: row.modelName ?? "",
      modelProvider: row.modelProvider ?? "",
      status: (row.status as "done" | "error") ?? "done",
      createdAt: row.createdAt,
    } satisfies AssistantNode;
  }

  return {
    id: row.id,
    role: "user",
    parentId: row.parentId,
    content: row.content,
    model: row.model ?? "",
    modelName: row.modelName ?? "",
    modelProvider: row.modelProvider ?? "",
    modelParams: row.modelParams ? JSON.parse(row.modelParams) : null,
    createdAt: row.createdAt,
  } satisfies UserNode;
}


function findLast(arr: TimelineEntry[], kind: string): TimelineEntry | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].kind === kind) return arr[i];
  }
  return undefined;
}

/* nanoid (inline, no external dependency at DO runtime) */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = "";
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] & 61];
  }
  return id;
}
/**
 * Custom adapter that extracts `reasoning_content` from OpenAI-compatible
 * streaming chunks (used by Anthropic thinking models via dogapi.cc proxy).
 * The base adapter has full REASONING event plumbing but its
 * `extractReasoning` is a no-op — we override it to activate.
 */
class ReasoningChatCompletionsAdapter extends OpenAIChatCompletionsTextAdapter<never> {
  protected extractReasoning(chunk: unknown): { text: string } | undefined {
    const c = chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> };
    const text = c?.choices?.[0]?.delta?.reasoning_content;
    if (text) return { text };
    return undefined;
  }
}
