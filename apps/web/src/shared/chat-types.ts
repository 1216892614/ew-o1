/* ── Chat Tree Types ────────────────────────────────────────
 *
 * Every message in a session is a node in a tree.
 *   - Root user messages have parentId = null
 *   - Assistant nodes are children of user nodes
 *   - User nodes are children of assistant nodes (or null for first message)
 *   - Siblings at the same parentId = versions (edits / retries)
 *
 * The "active path" is resolved from a leaf node ID upward to the root.
 * When no leaf is specified, the latest branch (rightmost child at each
 * level) is followed.
 */

/* ── Timeline entries (agent loop detail) ───────────────── */

export type ThinkingEntry = { kind: "thinking"; content: string; done: boolean };

export type ToolCallEntry = {
  kind: "tool_call";
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
  done: boolean;
};

export type TextEntry = { kind: "text"; content: string; streaming: boolean };


export type AskQuestion = {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multi?: boolean;
};

export type AskEntry = {
  kind: "ask";
  questions: AskQuestion[];
  answers?: Record<string, string | string[]>;
  resolved: boolean;
};

export type FinishEntry = { kind: "finish"; message: string };

export type AiSearchResultItem = {
  fileId: string;
  filename: string;
  snippet: string;
  score: number;
};

export type AiSearchEntry = {
  kind: "ai_search";
  query: string;
  results: AiSearchResultItem[];
  round: number;
};

export type TimelineEntry = ThinkingEntry | ToolCallEntry | TextEntry | AskEntry | FinishEntry | AiSearchEntry;

/* ── Attached files (files referenced in a user message) ── */

export interface AttachedFile {
  id: string;
  name: string;
  wordCount: number;
}

/* ── Injected context (notes fed to AI as system prompt) ── */

export interface InjectedContextItem {
  name: string;
  snippet: string;
  relevance?: number;
}

/* ── Node types ─────────────────────────────────────────── */

export interface UserNode {
  id: string;
  role: "user";
  parentId: string | null;
  content: string;
  attachedFiles?: AttachedFile[];
  model: string;
  modelName: string;
  modelProvider: string;
  modelParams: ModelParams | null;
  createdAt: number;
}

export interface AssistantNode {
  id: string;
  role: "assistant";
  parentId: string;
  content: string;
  timeline: TimelineEntry[];
  injectedContext?: InjectedContextItem[];
  model: string;
  modelName: string;
  modelProvider: string;
  status: "done" | "error" | "streaming" | "waiting";
  createdAt: number;
}

export type ChatNode = UserNode | AssistantNode;

/* ── Model params snapshot ──────────────────────────────── */

export interface ModelParams {
  temperature?: number;
  topP?: number;
  thinkingLevel?: "low" | "medium" | "high";
  maxPerRound?: number;
  /** Max input context tokens before auto-compression triggers. 0 = disabled. */
  contextLimit?: number;
}

/* ── API types ──────────────────────────────────────────── */

/** POST /api/chat body */
export interface ChatRequestBody {
  sessionId: string;
  notebookId: string;
  message: string;
  parentId: string | null;
  model: string;
  modelName?: string;
  modelProvider?: string;
  modelParams?: ModelParams;
  systemPrompt?: string;
  attachedFiles?: AttachedFile[];
  /** Tool names to exclude from this request */
  disabledTools?: string[];
  /** Compression mode for auto-compression: "native" tries provider cache first, "soft" always summarizes */
  compressMode?: "native" | "soft";
}

/** GET /api/chat/messages response */
export interface ChatMessagesResponse {
  nodes: ChatNode[];
  leafId: string | null;
}

/** POST /api/chat/answer body — user answers an ask() tool call */
export interface ChatAnswerBody {
  sessionId: string;
  notebookId: string;
  answers: Record<string, string | string[]>;
}

/* ── Tree utilities (shared between server and client) ──── */

/** Build a map from parentId → child nodes, ordered by createdAt */
export function buildChildrenMap(nodes: ChatNode[]): Map<string | null, ChatNode[]> {
  const map = new Map<string | null, ChatNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const arr = map.get(key);
    if (arr) {
      arr.push(node);
    } else {
      map.set(key, [node]);
    }
  }
  for (const children of map.values()) {
    children.sort((a, b) => a.createdAt - b.createdAt);
  }
  return map;
}

/**
 * Resolve the path from root to leaf. If leafId is null or not found,
 * follow the rightmost (latest) branch at each level.
 */
export function resolvePathToLeaf(
  nodes: ChatNode[],
  leafId: string | null,
): ChatNode[] {
  if (nodes.length === 0) return [];

  const byId = new Map<string, ChatNode>();
  for (const n of nodes) byId.set(n.id, n);

  // If leafId is valid, walk up to root, then reverse
  if (leafId && byId.has(leafId)) {
    const path: ChatNode[] = [];
    let current: ChatNode | undefined = byId.get(leafId);
    while (current) {
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  // Otherwise follow latest branch from root
  const childrenMap = buildChildrenMap(nodes);
  const path: ChatNode[] = [];
  let parentId: string | null = null;

  while (true) {
    const children = childrenMap.get(parentId);
    if (!children || children.length === 0) break;
    const latest = children[children.length - 1];
    path.push(latest);
    parentId = latest.id;
  }

  return path;
}

/**
 * Find the latest leaf node (deepest rightmost) for default navigation.
 */
export function findLatestLeaf(nodes: ChatNode[]): string | null {
  const path = resolvePathToLeaf(nodes, null);
  if (path.length === 0) return null;
  return path[path.length - 1].id;
}

/**
 * Get sibling count and index for version switching.
 * User nodes without a persisted assistant response are excluded from version
 * counting — they don't represent a real conversation branch yet.
 */
export function getSiblingInfo(
  nodes: ChatNode[],
  nodeId: string,
): { siblings: ChatNode[]; index: number } {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { siblings: [], index: -1 };

  /* Set of user node IDs that have at least one assistant child */
  const answeredUserIds = new Set(
    nodes
      .filter((n) => n.role === "assistant" && n.parentId)
      .map((n) => n.parentId!),
  );

  const siblings = nodes
    .filter((n) => {
      if (n.parentId !== node.parentId || n.role !== node.role) return false;
      /* Keep the current node even if unanswered (so user sees their own input),
       * but drop other unanswered user siblings — they don't count as versions. */
      if (n.role === "user" && n.id !== nodeId && !answeredUserIds.has(n.id)) return false;
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  return { siblings, index: siblings.findIndex((s) => s.id === nodeId) };
}
