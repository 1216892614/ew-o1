import { DurableObject } from "cloudflare:workers";
import { chat, toServerSentEventsResponse, type StreamChunk, type AnyTool } from "@tanstack/ai";
import { OpenAIChatCompletionsTextAdapter } from "@tanstack/ai-openai";
import { searchNotebook } from "../utils/aiSearchSync";
import type {
  ChatNode,
  UserNode,
  AssistantNode,
  TimelineEntry,
  ThinkingEntry,
  ToolCallEntry,
  AskEntry,
  FinishEntry,
  AiSearchEntry,
  AiSearchResultItem,
  AttachedFile,
  ChatRequestBody,
  ChatMessagesResponse,
  InjectedContextItem,
} from "@/shared/chat-types";
import { resolvePathToLeaf, findLatestLeaf } from "@/shared/chat-types";
import { createAgentTools, numberChunkLines } from "./tools";

/* ── Persisted row shape in DO SQLite ──────────────────── */

interface NodeRow {
  id: string;
  role: string;
  parentId: string | null;
  content: string;
  timeline: string | null;
  injected_context: string | null;
  attached_files: string | null;
  model: string | null;
  modelName: string | null;
  modelProvider: string | null;
  modelParams: string | null;
  status: string | null;
  createdAt: number;
  [key: string]: string | number | null;
}

/* ── Durable Object ────────────────────────────────────── */

export class ChatSessionDO extends DurableObject<Cloudflare.Env> {
  private notebookId = "";
  private sessionId = "";
  private contentHashMap = new Map<string, string>();
  private askResolver: { resolve: (v: unknown) => void } | null = null;
  private finishCalled = false;

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

      const hasContextCol = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(nodes)")
        .toArray()
        .some((c) => c.name === "injected_context");
      if (!hasContextCol) {
        this.ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN injected_context TEXT");
      }

      const hasAttachedFilesCol = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(nodes)")
        .toArray()
        .some((c) => c.name === "attached_files");
      if (!hasAttachedFilesCol) {
        this.ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN attached_files TEXT");
      }

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
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt,
                injected_context, attached_files
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
    this.contentHashMap.clear();
    this.finishCalled = false;

    const userNodeId = nanoid();
    const now = Date.now();

    const attachedFiles: AttachedFile[] = body.attachedFiles ?? [];

    const userNode: UserNode = {
      id: userNodeId,
      role: "user",
      parentId: body.parentId,
      content: body.message,
      attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      model: body.model,
      modelName: body.modelName ?? body.model,
      modelProvider: body.modelProvider ?? "",
      modelParams: body.modelParams ?? null,
      createdAt: now,
    };

    /* Delete unanswered sibling user nodes (same parentId, no assistant child).
     * This prevents empty user inputs from inflating version count. */
    this.ctx.storage.sql.exec(
      `DELETE FROM nodes WHERE role = 'user' AND parent_id IS ?
       AND id NOT IN (SELECT DISTINCT parent_id FROM nodes WHERE role = 'assistant' AND parent_id IS NOT NULL)`,
      body.parentId,
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at, attached_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      attachedFiles.length > 0 ? JSON.stringify(attachedFiles) : null,
    );

    /* Build the message path from root to this user node for LLM context */
    const allRows = this.ctx.storage.sql
      .exec<NodeRow>(
        `SELECT id, role, parent_id as parentId, content, timeline, model, model_name as modelName,
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt,
                injected_context, attached_files
         FROM nodes ORDER BY created_at ASC`,
      )
      .toArray();
    const allNodes = allRows.map(rowToNode);

    const pathToUser = resolvePathToLeaf(allNodes, userNodeId);
    const llmMessages = pathToUser.map((n) => {
      let content = n.content;
      if (n.role === "user" && n.attachedFiles && n.attachedFiles.length > 0) {
        const fileList = n.attachedFiles
          .map((f) => `- ${f.name} (file_id: ${f.id}, word_count: ${f.wordCount})`)
          .join("\n");
        content = `[attached files]\n${fileList}\n\n${content}`;
      }
      return { role: n.role as "user" | "assistant", content };
    });

    const systemPrompts: string[] = [];
    if (body.systemPrompt) {
      systemPrompts.push(body.systemPrompt);
    }
    const injectedContext: InjectedContextItem[] = [];
    const activeNoteIds = attachedFiles.map((f) => f.id);
    if (attachedFiles.length > 0) {
      for (const f of attachedFiles) {
        injectedContext.push({ name: f.name, snippet: `file_id: ${f.id}, word_count: ${f.wordCount}` });
      }
    }

    const aiSearchEntries: AiSearchEntry[] = [];
    const doAiSearch = async (query: string, round: number): Promise<string | null> => {
      if (!this.env.AI_SEARCH) return null;
      try {
        const chunks = await searchNotebook(this.env.AI_SEARCH, {
          notebookId: this.notebookId,
          query,
          maxResults: 5,
          noteIds: activeNoteIds.length > 0 ? activeNoteIds : undefined,
        });
        if (chunks.length === 0) return null;
        const resultItems: AiSearchResultItem[] = chunks.map((c) => ({
          fileId: (c.item.metadata?.note_id as string) ?? c.item.key ?? "",
          filename: (c.item.metadata?.filename as string) ?? c.item.key ?? "",
          snippet: c.text.slice(0, 300),
          score: c.score,
        }));
        aiSearchEntries.push({ kind: "ai_search", query, results: resultItems, round });
        const formatted = await Promise.all(
          resultItems.map(async (r) => {
            const numbered = await numberChunkLines(this.env.DB, r.fileId, r.snippet);
            return `### ${r.filename} (file_id: ${r.fileId}, relevance: ${r.score.toFixed(2)})\n${numbered}`;
          }),
        );
        return formatted.join("\n\n---\n\n");
      } catch {
        return null;
      }
    };

    const round1Context = await doAiSearch(body.message, 1);
    if (round1Context) {
      systemPrompts.push(`refs:\n\n${round1Context}`);
    }

    const adapter = this.createAdapter(body.model);

    const self = this;
    const tools = createAgentTools({
      env: this.env,
      notebookId: this.notebookId,
      contentHashMap: this.contentHashMap,
      askResolverRef: {
        get current() { return self.askResolver; },
        set current(v) { self.askResolver = v; },
      },
      finishFlagRef: {
        get current() { return self.finishCalled; },
        set current(v) { self.finishCalled = v; },
      },
      activeNoteIds,
    });

    /* Filter out client-disabled tools (e.g. "ask" when user toggles it off) */
    const disabledSet = new Set(body.disabledTools ?? []);
    const filteredTools = disabledSet.size > 0
      ? tools.filter((t: { name?: string }) => !disabledSet.has(t.name ?? ""))
      : tools;

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

    /* ── Multi-round agent loop with per-round AI Search ── */
    const outerStream = this.multiRoundAgentLoop({
      adapter,
      messages: llmMessages,
      systemPrompts,
      tools: filteredTools,
      modelOptions,
      model: body.model,
      contextLimit: body.modelParams?.contextLimit ?? 0,
      compressMode: body.compressMode ?? "native",
      doAiSearch,
      aiSearchEntries,
    });

    const assistantNodeId = nanoid();
    const teedStream = this.teeAndPersistAssistantResponse(
      outerStream,
      assistantNodeId,
      userNodeId,
      body.modelName ?? body.model,
      body.modelProvider ?? "",
      body.model,
      injectedContext,
      aiSearchEntries,
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

  async answer(answers: Record<string, string | string[]>) {
    if (this.askResolver) {
      this.askResolver.resolve({ answers });
      this.askResolver = null;
    }
  }

  /**
   * Compress conversation history.
   * "native" → check if provider supports prompt caching (most don't). Returns { supported: false } to fall back.
   * "soft"   → summarize entire conversation into a single system-summary + user-ask pair, delete old nodes.
   */
  async compress(mode: "native" | "soft", model: string, leafId: string | null): Promise<{ success: boolean; supported?: boolean; summary?: string }> {
    if (mode === "native") {
      return { success: false, supported: false };
    }

    const allRows = this.ctx.storage.sql
      .exec<NodeRow>(
        `SELECT id, role, parent_id as parentId, content, timeline, model, model_name as modelName,
                model_provider as modelProvider, model_params as modelParams, status, created_at as createdAt
         FROM nodes ORDER BY created_at ASC`,
      )
      .toArray();
    const allNodes = allRows.map(rowToNode);
    const path = resolvePathToLeaf(allNodes, leafId);

    if (path.length < 4) {
      return { success: false, summary: "对话太短，无需压缩" };
    }

    const conversationText = path
      .map((n) => `[${n.role}]: ${n.content.slice(0, 2000)}`)
      .join("\n\n");

    const summaryContent = await this.summarizeConversation(conversationText, model);
    if (!summaryContent) {
      return { success: false, summary: "压缩失败：无法生成摘要" };
    }

    const oldNodeIds = path.map((n) => n.id);
    for (const id of oldNodeIds) {
      this.ctx.storage.sql.exec("DELETE FROM nodes WHERE id = ?", id);
    }

    const now = Date.now();
    const summaryUserId = nanoid();
    const summaryAssistantId = nanoid();

    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      summaryUserId,
      "user",
      null,
      "[对话已压缩] 请基于以下摘要继续对话",
      null,
      model,
      "system",
      "compress",
      null,
      null,
      now,
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, model, model_name, model_provider, model_params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      summaryAssistantId,
      "assistant",
      summaryUserId,
      summaryContent,
      JSON.stringify([{ kind: "text", content: summaryContent, streaming: false }]),
      model,
      "system",
      "compress",
      null,
      "done",
      now + 1,
    );

    await this.flushToR2();

    return { success: true, summary: summaryContent.slice(0, 200) };
  }

  private createAdapter(model: string) {
    const isDeepseek = model.startsWith("deepseek");
    const apiKey = isDeepseek ? this.env.DEEPSEEK_AI_KEY : this.env.BIGBIGDOG_AI_KEY;
    const baseURL = isDeepseek
      ? `https://gateway.ai.cloudflare.com/v1/3244c8f91cd34317ce18652158e5853a/${this.env.CF_AI_GATEWAY_ID}/deepseek`
      : "https://www.dogapi.cc/v1";

    return new ReasoningChatCompletionsAdapter({ apiKey, baseURL }, model as any);
  }

  /* ── Auto-compression helpers ─────────────────────────── */

  /** Rough token estimate: ~3.5 chars per token for mixed CJK/English */
  private estimateTokens(messages: { content: string }[], systemPrompts: string[]): number {
    let chars = 0;
    for (const m of messages) chars += m.content.length;
    for (const s of systemPrompts) chars += s.length;
    return Math.ceil(chars / 3.5);
  }

  /** Shared LLM summarization call — used by both compress() and in-flight auto-compression */
  private async summarizeConversation(conversationText: string, model: string): Promise<string | null> {
    const isDeepseek = model.startsWith("deepseek");
    const apiKey = isDeepseek ? this.env.DEEPSEEK_AI_KEY : this.env.BIGBIGDOG_AI_KEY;
    const baseURL = isDeepseek
      ? `https://gateway.ai.cloudflare.com/v1/3244c8f91cd34317ce18652158e5853a/${this.env.CF_AI_GATEWAY_ID}/deepseek`
      : "https://www.dogapi.cc/v1";

    const summaryPrompt = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息、决策和结论。摘要应该能让 AI 继续对话而不丢失重要上下文。用中文回复。\n\n---\n${conversationText}\n---\n\n请输出压缩后的对话摘要:`;

    try {
      const resp = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: summaryPrompt }],
          max_tokens: 4096,
          stream: false,
        }),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Compress runningMessages in-place.
   * "native" → currently unsupported, returns "unsupported" so caller can warn + fallback.
   * "soft"   → LLM summarization, keeps last 2 messages.
   * Returns "ok" | "unsupported" | "failed".
   */
  private async compressMessages(
    runningMessages: { role: "user" | "assistant"; content: string }[],
    model: string,
    mode: "native" | "soft",
  ): Promise<"ok" | "unsupported" | "failed"> {
    if (mode === "native") {
      return "unsupported";
    }

    if (runningMessages.length < 4) return "failed";

    const keepCount = Math.min(2, runningMessages.length);
    const toCompress = runningMessages.slice(0, runningMessages.length - keepCount);
    const tail = runningMessages.slice(runningMessages.length - keepCount);

    const conversationText = toCompress
      .map((n) => `[${n.role}]: ${n.content.slice(0, 2000)}`)
      .join("\n\n");

    const summary = await this.summarizeConversation(conversationText, model);
    if (!summary) return "failed";

    runningMessages.length = 0;
    runningMessages.push(
      { role: "user", content: "[对话历史已自动压缩]\n\n" + summary },
      { role: "assistant", content: "已了解之前的对话上下文，继续当前任务。" },
      ...tail,
    );
    return "ok";
  }

  /** Check if an error indicates context length exceeded */
  private isContextLengthError(err: unknown): boolean {
    const msg = String(err);
    return /context.*(length|limit|window|exceed|too long)|maximum.*token|token.*limit|max_tokens|请求体过大/i.test(msg);
  }

  /**
   * Drive multiple single-pass chat() rounds, injecting fresh AI Search
   * context between rounds.  Round 1 uses the user query; subsequent rounds
   * use the assistant's latest text output as the search query.
   *
   * Auto-compresses conversation when context approaches the limit or
   * when the model returns a context-length error.
   *
   * Yields every StreamChunk from each inner chat() call so the outer
   * teeAndPersist wrapper can forward them to the client unchanged.
   */
  private async *multiRoundAgentLoop(opts: {
    adapter: unknown;
    messages: { role: "user" | "assistant"; content: string }[];
    systemPrompts: string[];
    tools: AnyTool[];
    modelOptions: Record<string, unknown>;
    model: string;
    contextLimit: number;
    compressMode: "native" | "soft";
    doAiSearch: (query: string, round: number) => Promise<string | null>;
    aiSearchEntries: AiSearchEntry[];
  }): AsyncIterable<StreamChunk> {
    const { adapter, messages, systemPrompts, tools, modelOptions, model, contextLimit, compressMode, doAiSearch, aiSearchEntries } = opts;

    const runningMessages = [...messages];
    const baseSystemPrompts = [...systemPrompts];
    let prevRoundHadToolCalls = false;

    for (let round = 1; ; round++) {
      if (this.finishCalled) break;

      let roundSystemPrompts = [...baseSystemPrompts];

      // Only inject AI Search when the previous round was NOT tool calls.
      // Tool-call rounds already fetched data; re-searching is redundant and slow.
      if (round > 1 && !prevRoundHadToolCalls) {
        let lastAssistantText = "";
        for (let i = runningMessages.length - 1; i >= 0; i--) {
          if (runningMessages[i].role === "assistant" && runningMessages[i].content) {
            lastAssistantText = runningMessages[i].content.slice(0, 500);
            break;
          }
        }
        if (lastAssistantText) {
          const prevLen = aiSearchEntries.length;
          const ctx = await doAiSearch(lastAssistantText, round);
          if (ctx) {
            roundSystemPrompts = [
              ...baseSystemPrompts,
              `refs (round ${round}):\n\n${ctx}`,
            ];
            const newEntry = aiSearchEntries[aiSearchEntries.length - 1];
            if (aiSearchEntries.length > prevLen && newEntry) {
              yield { type: "CUSTOM", name: "ai_search", value: newEntry } as unknown as StreamChunk;
            }
          }
        }
      }

      /* ── Auto-compress helper: respect mode, native→soft fallback with warning ── */
      const tryCompress = async (): Promise<{ ok: boolean; warning?: string }> => {
        let result = await this.compressMessages(runningMessages, model, compressMode);
        if (result === "unsupported") {
          result = await this.compressMessages(runningMessages, model, "soft");
          if (result === "ok") return { ok: true, warning: "当前模型不支持原生压缩，已回退到软压缩" };
          return { ok: false, warning: "当前模型不支持原生压缩，软压缩也失败了" };
        }
        return { ok: result === "ok" };
      };

      /* ── Proactive compression: check before sending to model ── */
      if (contextLimit > 0) {
        const estimated = this.estimateTokens(runningMessages, roundSystemPrompts);
        if (estimated > contextLimit * 0.85) {
          const cr = await tryCompress();
          if (cr.warning) {
            yield { type: "CUSTOM", name: "compression", value: { reason: "warning", message: cr.warning } } as unknown as StreamChunk;
          }
          if (cr.ok) {
            yield { type: "CUSTOM", name: "compression", value: { reason: "proactive", estimatedTokens: estimated, limit: contextLimit } } as unknown as StreamChunk;
          }
        }
      }

      /* ── Run inner chat with reactive compression on error ── */
      let retried = false;
      const runRound = async function* (self: ChatSessionDO) {
        const innerStream = chat({
          adapter: adapter as Parameters<typeof chat>[0]["adapter"],
          messages: runningMessages,
          systemPrompts: roundSystemPrompts.length > 0 ? roundSystemPrompts : undefined,
          tools,
          agentLoopStrategy: () => !self.finishCalled,
          modelOptions: modelOptions as never,
        });

        for await (const chunk of innerStream) {
          yield chunk;
        }
      };

      let roundAssistantText = "";
      let hadToolCalls = false;
      const toolCallSummaries: { name: string; args: string; result: string }[] = [];
      let currentToolCall: { id: string; name: string; args: string; result: string } | null = null;

      const processChunk = (chunk: StreamChunk) => {
        const type = chunk.type as string;
        const c = chunk as Record<string, unknown>;
        if (type === "TEXT_MESSAGE_CONTENT") {
          roundAssistantText += (c.delta ?? "") as string;
        }
        if (type === "TOOL_CALL_START") {
          hadToolCalls = true;
          currentToolCall = {
            id: (c.toolCallId ?? "") as string,
            name: ((c.toolCallName ?? c.toolName ?? "tool") as string),
            args: "",
            result: "",
          };
        }
        if (type === "TOOL_CALL_ARGS" && currentToolCall && c.toolCallId === currentToolCall.id) {
          currentToolCall.args += (c.delta ?? "") as string;
        }
        if ((type === "TOOL_CALL_END" || type === "TOOL_CALL_RESULT") && currentToolCall) {
          if (c.toolCallId === currentToolCall.id) {
            const raw = (c.result ?? c.content ?? "") as string;
            currentToolCall.result = typeof raw === "string" ? raw : JSON.stringify(raw);
            toolCallSummaries.push({
              name: currentToolCall.name,
              args: currentToolCall.args.slice(0, 500),
              result: currentToolCall.result.slice(0, 800),
            });
            currentToolCall = null;
          }
        }
      };

      try {
        for await (const chunk of runRound(this)) {
          processChunk(chunk);
          yield chunk;
        }
      } catch (err) {
        /* ── Reactive compression: model rejected due to context length ── */
        if (!retried && this.isContextLengthError(err)) {
          retried = true;
          const cr = await tryCompress();
          if (cr.warning) {
            yield { type: "CUSTOM", name: "compression", value: { reason: "warning", message: cr.warning } } as unknown as StreamChunk;
          }
          if (cr.ok) {
            yield { type: "CUSTOM", name: "compression", value: { reason: "reactive", error: String(err).slice(0, 200) } } as unknown as StreamChunk;

            // Retry the round with compressed messages
            roundAssistantText = "";
            hadToolCalls = false;
            toolCallSummaries.length = 0;
            currentToolCall = null;
            for await (const chunk of runRound(this)) {
              processChunk(chunk);
              yield chunk;
            }
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      prevRoundHadToolCalls = hadToolCalls;
      if (this.finishCalled) break;

      /* ── Build round context for next iteration ─────────────────────
       *  The inner chat() manages tool loops within a round, but the outer
       *  loop loses tool-call context between rounds. Inject a structured
       *  summary so the model knows what it already did. ── */

      const summaryParts: string[] = [];
      if (roundAssistantText) {
        summaryParts.push(`你的回复：\n${roundAssistantText}`);
      }
      if (toolCallSummaries.length > 0) {
        const toolLines = toolCallSummaries.map((tc, i) =>
          `  ${i + 1}. ${tc.name}(${tc.args}) → ${tc.result}`,
        );
        summaryParts.push(`你调用的工具：\n${toolLines.join("\n")}`);
      }

      // Push assistant text so conversation structure stays valid
      if (roundAssistantText) {
        runningMessages.push({ role: "assistant", content: roundAssistantText });
      }

      // Inject round context as a user message for the next round
      const roundHint = [
        `[系统] 当前是第 ${round + 1} 轮（已完成 ${round} 轮）。`,
        summaryParts.length > 0 ? `上一轮摘要：\n${summaryParts.join("\n\n")}` : "",
        "如果任务已完成，请先输出总结，然后调用 finish 工具结束。如果还需要继续，请继续执行。",
      ].filter(Boolean).join("\n");
      runningMessages.push({ role: "user", content: roundHint });
    }
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
    injectedContext: InjectedContextItem[],
    aiSearchEntries: AiSearchEntry[],
  ): AsyncIterable<StreamChunk> {
    /* Emit injected context as first event so client can display it */
    if (injectedContext.length > 0) {
      yield { type: "CUSTOM", name: "injected_context", value: { items: injectedContext } } as unknown as StreamChunk;
    }

    /* Emit round-1 AI Search results so client can display them in timeline */
    for (const entry of aiSearchEntries) {
      yield { type: "CUSTOM", name: "ai_search", value: entry } as unknown as StreamChunk;
    }

    const timeline: TimelineEntry[] = [...aiSearchEntries];
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

            const toolName = entry.name;
            if (toolName === "ask") {
              try {
                const args = JSON.parse(entry.args);
                timeline.push({ kind: "ask", questions: args.questions ?? [], resolved: false } satisfies AskEntry);
              } catch {}
            } else if (toolName === "finish") {
              timeline.push({ kind: "finish" } satisfies FinishEntry);
            }
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
        case "CUSTOM": {
          const cd = chunk as Record<string, unknown>;
          if (cd.name === "ai_search" && cd.value) {
            timeline.push(cd.value as AiSearchEntry);
          }
          break;
        }
        default:
          break;
      }

      yield chunk;
    }

    /* Persist assistant node to DO SQLite */
    const fullContent = contentParts.join("");
    const hasUnresolvedAsk = timeline.some((e) => e.kind === "ask" && !e.resolved);
    const nodeStatus = hasUnresolvedAsk ? "waiting" : "done";
    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, role, parent_id, content, timeline, injected_context, model, model_name, model_provider, model_params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assistantNodeId,
      "assistant",
      userNodeId,
      fullContent,
      JSON.stringify(timeline),
      injectedContext.length > 0 ? JSON.stringify(injectedContext) : null,
      model,
      modelName,
      modelProvider,
      null,
      nodeStatus,
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
        `SELECT id, role, parent_id as parentId, content, timeline, injected_context,
                model, model_name as modelName, model_provider as modelProvider,
                model_params as modelParams, status, created_at as createdAt
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
    let injectedContext: InjectedContextItem[] | undefined;
    if (row.injected_context) {
      try { injectedContext = JSON.parse(row.injected_context); } catch {}
    }
    return {
      id: row.id,
      role: "assistant",
      parentId: row.parentId ?? "",
      content: row.content,
      timeline,
      injectedContext,
      model: row.model ?? "",
      modelName: row.modelName ?? "",
      modelProvider: row.modelProvider ?? "",
      status: (row.status as "done" | "error") ?? "done",
      createdAt: row.createdAt,
    } satisfies AssistantNode;
  }

  let attachedFilesArr: AttachedFile[] | undefined;
  if (row.attached_files) {
    try { attachedFilesArr = JSON.parse(row.attached_files); } catch {}
  }

  return {
    id: row.id,
    role: "user",
    parentId: row.parentId,
    content: row.content,
    attachedFiles: attachedFilesArr,
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class ReasoningChatCompletionsAdapter extends OpenAIChatCompletionsTextAdapter<any> {
  protected extractReasoning(chunk: unknown): { text: string } | undefined {
    const c = chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> };
    const text = c?.choices?.[0]?.delta?.reasoning_content;
    if (text) return { text };
    return undefined;
  }
}
