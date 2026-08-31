/**
 * Worker secrets absent from auto-generated worker-configuration.d.ts.
 * Merges into Cloudflare.Env so c.env resolves with concrete bindings.
 */
interface CloudflareBindings {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  AI_SEARCH: AiSearchNamespace;
  CHAT_DO: DurableObjectNamespace<import("./src/server/chat/ChatSessionDO").ChatSessionDO>;
  BIGBIGDOG_AI_KEY: string;
  DEEPSEEK_AI_KEY: string;
  CF_AI_GATEWAY_ID: string;
  BROWSER: BrowserRun;
  SEARXNG: DurableObjectNamespace<import("./src/server/searxng/SearXNG").SearXNG>;
  SHARE_KV: KVNamespace;
}

declare module "cloudflare:workers" {
  interface Env extends CloudflareBindings {}
}

declare namespace Cloudflare {
  interface Env extends CloudflareBindings {}
}

// --- AI Search Types (Workers binding) ----------------------------------------

interface AiSearchNamespace {
  get(instanceId: string): AiSearchInstance;
  create(options: {
    id: string;
    custom_metadata?: { field_name: string; data_type: "text" | "number" | "boolean" | "datetime" }[];
    index_method?: { vector?: boolean; keyword?: boolean };
    metadata_fields?: { name: string; type: string }[];
  }): Promise<AiSearchInstance>;
  list(): Promise<{ result: { id: string }[] }>;
  delete(instanceId: string): Promise<void>;
}

interface AiSearchInstance {
  search(options: {
    messages: { role: string; content: string }[];
    ai_search_options?: {
      retrieval?: {
        retrieval_type?: "vector" | "keyword" | "hybrid";
        match_threshold?: number;
        max_num_results?: number;
        filters?: Record<string, unknown>;
        context_expansion?: number;
      };
    };
    stream?: boolean;
  }): Promise<{
    chunks: AiSearchChunk[];
    response?: string;
  }>;
  items: AiSearchItems;
}

interface AiSearchItems {
  upload(name: string, content: string | ArrayBuffer | ReadableStream, options?: {
    metadata?: Record<string, string>;
  }): Promise<{ id: string; key: string }>;
  uploadAndPoll(name: string, content: string | ArrayBuffer | ReadableStream, options?: {
    metadata?: Record<string, string>;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ id: string; key: string; status: string; chunks_count: number }>;
  list(options?: { page?: number; per_page?: number; status?: string }): Promise<{
    result: { id: string; key: string; status: string }[];
    result_info: { total_count: number };
  }>;
  delete(itemId: string): Promise<void>;
  get(itemId: string): { info(): Promise<{ id: string; key: string; status: string }>; download(): Promise<Response> };
}

interface AiSearchChunk {
  id: string;
  type: string;
  score: number;
  text: string;
  item: {
    timestamp?: number;
    key: string;
    metadata?: Record<string, unknown>;
  };
  scoring_details?: Record<string, unknown>;
}

// --- Browser Rendering (Browser Run) -----------------------------------------

interface BrowserRun {
  quickAction(action: "screenshot", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "pdf", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "content", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "markdown", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "links", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "scrape", options: { url: string; elements: { selector: string }[]; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "json", options: { url: string; prompt: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: "snapshot", options: { url: string; options?: Record<string, unknown> }): Promise<Response>;
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
}

// ExportedHandler from @cloudflare/workers-types
type ExportedHandler<E = unknown> = {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>;
};
