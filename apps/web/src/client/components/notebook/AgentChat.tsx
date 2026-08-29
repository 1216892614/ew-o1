import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  ChatCircleDots,
  PaperPlaneRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  Stop,
  Plus,
  Copy,
  PencilSimple,
  ArrowCounterClockwise,
  Check,
  X,
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { trpc } from "@/client/lib/trpc";
import type { ModelConfig } from "./ModelSelector";
import type {
  ChatNode,
  UserNode,
  AssistantNode,
  TimelineEntry,
  ThinkingEntry,
  ToolCallEntry,
  TextEntry,
  ChatRequestBody,
  ChatMessagesResponse,
} from "@/shared/chat-types";
import {
  resolvePathToLeaf,
  findLatestLeaf,
  buildChildrenMap,
  getSiblingInfo,
} from "@/shared/chat-types";

/* ── Props ──────────────────────────────────────────────── */

type NoteItem = {
  id: string;
  name: string;
  content: string | null;
  active: boolean | null;
};

interface AgentChatProps {
  notebookId: string;
  modelConfig: ModelConfig;
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  leafId: string | null;
  setLeafId: (id: string | null) => void;
  onOpenModelSelector: () => void;
  onOpenSessionSelector: () => void;
  draggedNoteIds: string[];
  notesList: NoteItem[];
}

/* ── Streaming assistant state ──────────────────────────── */

interface StreamingAssistant {
  id: string;
  parentId: string;
  modelName: string;
  modelProvider: string;
  startTime: number;
  status: "sending" | "thinking" | "tool_call" | "replying" | "done" | "error";
  timeline: TimelineEntry[];
}

/* ── Main component ─────────────────────────────────────── */

export function AgentChat({
  notebookId,
  modelConfig,
  currentSessionId,
  setCurrentSessionId,
  leafId,
  setLeafId,
  onOpenModelSelector,
  onOpenSessionSelector,
  draggedNoteIds,
  notesList,
}: AgentChatProps) {
  const [allNodes, setAllNodes] = useState<ChatNode[]>([]);
  const [streamingAssistant, setStreamingAssistantState] = useState<StreamingAssistant | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevDraggedRef = useRef<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const skipLoadHistoryRef = useRef(false);
  const streamingAssistantRef = useRef<StreamingAssistant | null>(null);

  /* Wrapper to keep ref in sync with state */
  const setStreamingAssistant = useCallback((action: StreamingAssistant | null | ((prev: StreamingAssistant | null) => StreamingAssistant | null)) => {
    if (typeof action === "function") {
      setStreamingAssistantState((prev) => {
        const next = action(prev);
        streamingAssistantRef.current = next;
        return next;
      });
    } else {
      streamingAssistantRef.current = action;
      setStreamingAssistantState(action);
    }
  }, []);

  const utils = trpc.useUtils();
  const { data: sessions } = trpc.notes.listSessions.useQuery({ notebookId });
  const currentSession = sessions?.find((s) => s.id === currentSessionId);
  const createSessionMut = trpc.notes.createSession.useMutation({
    onSuccess: () => {
      utils.notes.listSessions.invalidate({ notebookId });
    },
  });

  /* Compute active path from allNodes + leafId */
  const activePath = resolvePathToLeaf(allNodes, leafId);
  const activePathIds = new Set(activePath.map((n) => n.id));

  function handleNewChat() {
    setCurrentSessionId(null);
    setLeafId(null);
    setAllNodes([]);
    setStreamingAssistant(null);
  }

  const { setNodeRef, isOver } = useDroppable({ id: "chat-drop-zone" });

  /* Load history */
  useEffect(() => {
    if (!currentSessionId || !notebookId) return;
    if (skipLoadHistoryRef.current) {
      skipLoadHistoryRef.current = false;
      return;
    }
    loadHistory(notebookId, currentSessionId);
  }, [currentSessionId, notebookId]);

  async function loadHistory(nbId: string, sessionId: string) {
    try {
      const response = await fetch(
        `/api/chat/messages?notebookId=${encodeURIComponent(nbId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as ChatMessagesResponse;
      setAllNodes(data.nodes);
      if (!leafId || !data.nodes.find((n) => n.id === leafId)) {
        setLeafId(data.leafId);
      }
    } catch {
      // silently fail
    }
  }

  /* Note drop */
  const handleNoteDrop = useCallback(
    (_noteIds: string[]) => {
      // System messages are not part of the tree; just show a toast or similar
    },
    [],
  );

  useEffect(() => {
    if (prevDraggedRef.current.length > 0 && draggedNoteIds.length === 0 && isOver) {
      handleNoteDrop(prevDraggedRef.current);
    }
    prevDraggedRef.current = draggedNoteIds;
  }, [draggedNoteIds, isOver, handleNoteDrop]);

  /* Auto-scroll */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activePath, streamingAssistant]);

  /* ── Navigate to a different leaf ─────────────────────── */
  function navigateToLeaf(nodeId: string) {
    /* Find the deepest descendant of this node to use as leaf */
    const childrenMap = buildChildrenMap(allNodes);
    let current = nodeId;
    while (true) {
      const children = childrenMap.get(current);
      if (!children || children.length === 0) break;
      current = children[children.length - 1].id;
    }
    setLeafId(current);
  }

  /* ── Send message ─────────────────────────────────────── */
  async function sendMessage(overrideText?: string, parentIdOverride?: string | null) {
    const text = overrideText ?? input.trim();
    if (!text || isStreaming) return;

    let sessionId = currentSessionId;

    if (!sessionId) {
      try {
        const res = await createSessionMut.mutateAsync({
          notebookId,
          name: text.slice(0, 80),
        });
        sessionId = res.id;
        skipLoadHistoryRef.current = true;
        setCurrentSessionId(sessionId);
      } catch {
        return;
      }
    }

    /* Determine parentId: the last node on the active path, or override */
    const parentId = parentIdOverride !== undefined
      ? parentIdOverride
      : activePath.length > 0
        ? activePath[activePath.length - 1].id
        : null;

    if (!overrideText) setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const activeNotes = notesList
      .filter((n) => n.active && n.content)
      .map((n) => ({ name: n.name, content: n.content ?? "" }));

    /* Optimistic user node — shows immediately */
    const tempUserNodeId = `temp_${Date.now()}`;
    const optimisticUserNode: UserNode = {
      id: tempUserNodeId,
      role: "user",
      parentId,
      content: text,
      model: modelConfig.model.id,
      modelName: modelConfig.model.name,
      modelProvider: modelConfig.model.provider,
      modelParams: modelConfig.params,
      createdAt: Date.now(),
    };
    setAllNodes((prev) => [...prev, optimisticUserNode]);
    setLeafId(tempUserNodeId);

    const assistantId = crypto.randomUUID();
    setStreamingAssistant({
      id: assistantId,
      parentId: tempUserNodeId,
      modelName: modelConfig.model.name,
      modelProvider: modelConfig.model.provider,
      startTime: Date.now(),
      status: "sending",
      timeline: [],
    });

    try {
      const requestBody: ChatRequestBody = {
        sessionId,
        notebookId,
        message: text,
        parentId,
        model: modelConfig.model.id,
        modelName: modelConfig.model.name,
        modelProvider: modelConfig.model.provider,
        modelParams: modelConfig.params,
        activeNotes,
      };

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Chat request failed: ${response.status}`);
      }

      /* Read the server-assigned node IDs from headers */
      const serverUserNodeId = response.headers.get("X-User-Node-Id");
      const serverAssistantNodeId = response.headers.get("X-Assistant-Node-Id");

      /* Replace temp user node ID with server-assigned ID */
      if (serverUserNodeId) {
        setAllNodes((prev) =>
          prev.map((n) => (n.id === tempUserNodeId ? { ...n, id: serverUserNodeId } : n)),
        );
        setLeafId(serverUserNodeId);
        setStreamingAssistant((prev) =>
          prev ? { ...prev, parentId: serverUserNodeId, id: serverAssistantNodeId ?? prev.id } : prev,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const updateStreaming = (fn: (s: StreamingAssistant) => StreamingAssistant) => {
        setStreamingAssistant((prev) => (prev ? fn(prev) : prev));
      };

      const updateTimeline = (fn: (tl: TimelineEntry[]) => TimelineEntry[]) => {
        updateStreaming((s) => ({ ...s, timeline: fn(s.timeline) }));
      };

      const lastEntry = (tl: TimelineEntry[], kind: string) => {
        for (let i = tl.length - 1; i >= 0; i--) {
          if (tl[i].kind === kind) return tl[i];
        }
        return null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;

          try {
            const evt = JSON.parse(raw) as Record<string, unknown>;
            const type = evt.type as string;

            switch (type) {
              case "THINKING_START":
              case "REASONING_START": {
                updateStreaming((s) => ({ ...s, status: "thinking" }));
                updateTimeline((tl) => [...tl, { kind: "thinking", content: "", done: false }]);
                break;
              }
              case "THINKING_TEXT_MESSAGE_CONTENT":
              case "REASONING_MESSAGE_CONTENT": {
                const delta = (evt.delta ?? evt.content ?? "") as string;
                if (!delta) break;
                updateTimeline((tl) => {
                  const last = lastEntry(tl, "thinking") as ThinkingEntry | null;
                  if (!last) return [...tl, { kind: "thinking", content: delta, done: false }];
                  return tl.map((e) => (e === last ? { ...last, content: last.content + delta } : e));
                });
                break;
              }
              case "THINKING_END":
              case "REASONING_END": {
                updateTimeline((tl) =>
                  tl.map((e) => (e.kind === "thinking" && !e.done ? { ...e, done: true } : e)),
                );
                break;
              }

              case "TOOL_CALL_START": {
                updateStreaming((s) => ({ ...s, status: "tool_call" }));
                updateTimeline((tl) => [
                  ...tl,
                  {
                    kind: "tool_call",
                    toolCallId: evt.toolCallId as string,
                    name: (evt.toolCallName ?? evt.toolName ?? "tool") as string,
                    args: "",
                    done: false,
                  },
                ]);
                break;
              }
              case "TOOL_CALL_ARGS": {
                const delta = (evt.delta ?? "") as string;
                const tcId = evt.toolCallId as string;
                updateTimeline((tl) =>
                  tl.map((e) =>
                    e.kind === "tool_call" && e.toolCallId === tcId
                      ? { ...e, args: e.args + delta }
                      : e,
                  ),
                );
                break;
              }
              case "TOOL_CALL_END": {
                const tcId = evt.toolCallId as string;
                const result = evt.result != null ? JSON.stringify(evt.result) : undefined;
                updateTimeline((tl) =>
                  tl.map((e) =>
                    e.kind === "tool_call" && e.toolCallId === tcId
                      ? { ...e, done: true, result: result ?? e.result }
                      : e,
                  ),
                );
                break;
              }
              case "TOOL_CALL_RESULT": {
                const tcId = evt.toolCallId as string;
                const content = (evt.content ?? evt.result ?? "") as string;
                updateTimeline((tl) =>
                  tl.map((e) =>
                    e.kind === "tool_call" && e.toolCallId === tcId
                      ? { ...e, done: true, result: content }
                      : e,
                  ),
                );
                break;
              }

              case "TEXT_MESSAGE_START": {
                updateStreaming((s) => ({ ...s, status: "replying" }));
                updateTimeline((tl) => [...tl, { kind: "text", content: "", streaming: true }]);
                break;
              }
              case "TEXT_MESSAGE_CONTENT": {
                const delta = (evt.delta ?? "") as string;
                if (!delta) break;
                updateStreaming((s) => (s.status !== "replying" ? { ...s, status: "replying" } : s));
                updateTimeline((tl) => {
                  const last = tl[tl.length - 1];
                  if (last?.kind === "text" && last.streaming) {
                    return [...tl.slice(0, -1), { ...last, content: last.content + delta }];
                  }
                  return [...tl, { kind: "text", content: delta, streaming: true }];
                });
                break;
              }
              case "TEXT_MESSAGE_END": {
                updateTimeline((tl) =>
                  tl.map((e) => (e.kind === "text" && e.streaming ? { ...e, streaming: false } : e)),
                );
                break;
              }

              case "RUN_FINISHED": {
                updateStreaming((s) => ({ ...s, status: "done" }));
                break;
              }
              case "RUN_ERROR": {
                const errMsg = (evt.message ?? "Unknown error") as string;
                updateStreaming((s) => ({ ...s, status: "error" }));
                updateTimeline((tl) => [...tl, { kind: "text", content: `Error: ${errMsg}`, streaming: false }]);
                break;
              }
              default:
                break;
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        updateStreamingOnError();
      }
    } finally {
      finalizeStreaming();
      setIsStreaming(false);
      abortControllerRef.current = null;
    }

    function updateStreamingOnError() {
      setStreamingAssistant((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: "error",
          timeline: [...prev.timeline, { kind: "text", content: "Error: connection failed", streaming: false }],
        };
      });
    }

    function finalizeStreaming() {
      /* Read the streaming state from ref (always current, no batching delay) */
      const prev = streamingAssistantRef.current;
      if (!prev) {
        setStreamingAssistant(null);
        return;
      }

      const assistantNode: AssistantNode = {
        id: prev.id,
        role: "assistant" as const,
        parentId: prev.parentId,
        content: prev.timeline
          .filter((t): t is TextEntry => t.kind === "text")
          .map((t) => t.content)
          .join(""),
        timeline: prev.timeline.map((t) => {
          if (t.kind === "text") return { ...t, streaming: false };
          if (t.kind === "thinking") return { ...t, done: true };
          if (t.kind === "tool_call") return { ...t, done: true };
          return t;
        }),
        model: modelConfig.model.id,
        modelName: prev.modelName,
        modelProvider: prev.modelProvider,
        status: prev.status === "error" ? "error" : "done",
        createdAt: prev.startTime,
      };

      setStreamingAssistant(null);
      setAllNodes((nodes) => [...nodes, assistantNode]);
      setLeafId(assistantNode.id);
    }
  }

  function stopStreaming() {
    abortControllerRef.current?.abort();
  }

  /* ── Edit user message ────────────────────────────────── */
  function handleEditUserMessage(nodeId: string, newContent: string) {
    const node = allNodes.find((n) => n.id === nodeId);
    if (!node || node.role !== "user") return;
    /* Send as a new sibling: same parentId as the edited node */
    sendMessage(newContent, node.parentId);
  }

  /* ── Retry (re-generate from a user message) ──────────── */
  function handleRetry(userNodeId: string) {
    const node = allNodes.find((n) => n.id === userNodeId);
    if (!node || node.role !== "user") return;
    sendMessage(node.content, node.parentId);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  /* ── Build render list from active path + optional streaming ── */
  const renderNodes: Array<{ node: ChatNode; isStreaming: false } | { streaming: StreamingAssistant; isStreaming: true }> = [];
  for (const node of activePath) {
    renderNodes.push({ node, isStreaming: false });
  }
  if (streamingAssistant) {
    renderNodes.push({ streaming: streamingAssistant, isStreaming: true });
  }

  /* ── Render ───────────────────────────────────────────── */
  return (
    <div ref={setNodeRef} className="flex flex-col flex-1 overflow-hidden relative">
      {/* Toolbar */}
      <div className="h-10 border-b border-base-300 flex items-center px-3 shrink-0">
        <button type="button" className="btn btn-ghost btn-xs gap-1 font-normal" onClick={onOpenModelSelector}>
          <span className="truncate max-w-[120px]">{modelConfig.model.name}</span>
          <span className="badge badge-xs badge-outline">{modelConfig.model.provider}</span>
          <CaretDown size={12} />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn btn-ghost btn-xs gap-1 font-normal" onClick={onOpenSessionSelector}>
            <span className="truncate max-w-[140px]">{currentSession?.name ?? "New Chat"}</span>
            <CaretDown size={12} />
          </button>
          <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={handleNewChat} title="New Chat">
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        {renderNodes.length === 0 && !streamingAssistant ? (
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/40 gap-2">
            <ChatCircleDots size={48} weight="thin" />
            <span className="text-sm">Start a conversation</span>
          </div>
        ) : (
          renderNodes.map((item) => {
            if (item.isStreaming) {
              return (
                <StreamingAssistantBlock
                  key={`streaming-${item.streaming.id}`}
                  assistant={item.streaming}
                />
              );
            }
            const { node } = item;
            if (node.role === "user") {
              return (
                <UserBubble
                  key={node.id}
                  node={node}
                  allNodes={allNodes}
                  onEdit={handleEditUserMessage}
                  onRetry={handleRetry}
                  onNavigate={navigateToLeaf}
                />
              );
            }
            return (
              <AssistantBlock
                key={node.id}
                node={node}
                onRetry={() => {
                  const userNode = allNodes.find((n) => n.id === node.parentId);
                  if (userNode && userNode.role === "user") {
                    sendMessage(userNode.content, userNode.parentId);
                  }
                }}
              />
            );
          })
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Drop overlay */}
      {isOver && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none z-10">
          <span className="text-primary font-medium text-sm">Drop notes to add context</span>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-base-300 p-3 shrink-0">
        <div className="relative">
          <textarea
            ref={textareaRef}
            className="textarea textarea-bordered w-full pr-12 resize-none"
            rows={1}
            style={{ maxHeight: "6rem" }}
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 96)}px`;
            }}
          />
          {isStreaming ? (
            <button type="button" className="btn btn-error btn-sm absolute bottom-2 right-2" onClick={stopStreaming}>
              <Stop size={16} weight="bold" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm absolute bottom-2 right-2"
              onClick={() => sendMessage()}
              disabled={!input.trim()}
            >
              <PaperPlaneRight size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Version navigator (shared between user and assistant) ── */

function VersionNavigator({
  nodeId,
  allNodes,
  onNavigate,
}: {
  nodeId: string;
  allNodes: ChatNode[];
  onNavigate: (nodeId: string) => void;
}) {
  const { siblings, index } = getSiblingInfo(allNodes, nodeId);
  if (siblings.length <= 1) return null;

  return (
    <div className="flex items-center gap-1 text-xs text-base-content/50">
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        disabled={index <= 0}
        onClick={() => onNavigate(siblings[index - 1].id)}
      >
        <CaretLeft size={12} />
      </button>
      <span>
        {index + 1} / {siblings.length}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        disabled={index >= siblings.length - 1}
        onClick={() => onNavigate(siblings[index + 1].id)}
      >
        <CaretRight size={12} />
      </button>
    </div>
  );
}

/* ── User bubble ────────────────────────────────────────── */

function UserBubble({
  node,
  allNodes,
  onEdit,
  onRetry,
  onNavigate,
}: {
  node: UserNode;
  allNodes: ChatNode[];
  onEdit: (nodeId: string, newContent: string) => void;
  onRetry: (nodeId: string) => void;
  onNavigate: (nodeId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(node.content);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(node.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleSubmitEdit() {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== node.content) {
      onEdit(node.id, trimmed);
    }
    setIsEditing(false);
  }

  function handleCancelEdit() {
    setEditText(node.content);
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] w-full flex flex-col gap-2">
          <textarea
            className="textarea textarea-bordered w-full resize-none text-sm"
            rows={3}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmitEdit();
              }
              if (e.key === "Escape") handleCancelEdit();
            }}
            autoFocus
          />
          <div className="flex justify-end gap-1">
            <button type="button" className="btn btn-ghost btn-xs" onClick={handleCancelEdit}>
              <X size={14} /> Cancel
            </button>
            <button type="button" className="btn btn-primary btn-xs" onClick={handleSubmitEdit}>
              <Check size={14} /> Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      {/* Version navigator above the bubble */}
      <VersionNavigator nodeId={node.id} allNodes={allNodes} onNavigate={onNavigate} />

      {/* Bubble */}
      <div className="bg-primary text-primary-content rounded-2xl rounded-br-md px-4 py-2 max-w-[75%] text-sm whitespace-pre-wrap">
        {node.content}
      </div>

      {/* Inline action buttons below */}
      <div className="flex items-center gap-0.5">
        <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={handleCopy} title="Copy">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square"
          onClick={() => {
            setEditText(node.content);
            setIsEditing(true);
          }}
          title="Edit"
        >
          <PencilSimple size={12} />
        </button>
        <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={() => onRetry(node.id)} title="Retry">
          <ArrowCounterClockwise size={12} />
        </button>
      </div>
    </div>
  );
}

/* ── Assistant block (persisted) ────────────────────────── */

function AssistantBlock({
  node,
  onRetry,
}: {
  node: AssistantNode;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const hasTimelineEvents = node.timeline.some((t) => t.kind === "thinking" || t.kind === "tool_call");

  function handleCopy() {
    navigator.clipboard.writeText(node.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /* Compute elapsed from timeline */
  const elapsed = node.timeline.length > 0
    ? Math.max(1, Math.round((Date.now() - node.createdAt) / 1000))
    : 0;

  return (
    <div className="flex flex-col gap-0.5">
      {/* Timeline */}
      <div className="flex flex-col gap-1">
        {node.timeline.map((entry, i) => (
          <TimelineNode key={i} entry={entry} hasTimeline={hasTimelineEvents} />
        ))}
      </div>

      {/* Bottom-left: model name, elapsed, status, actions */}
      <div className="flex items-center gap-2 text-[10px] text-base-content/30">
        {node.modelName && <span>{node.modelName}</span>}
        {elapsed > 0 && <span>{elapsed}s</span>}
        {node.status === "error" && <StatusBadge status="error" />}

        <div className="flex items-center gap-0.5">
          <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={handleCopy} title="Copy">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={onRetry} title="Retry">
            <ArrowCounterClockwise size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Streaming assistant block ──────────────────────────── */

function StreamingAssistantBlock({ assistant }: { assistant: StreamingAssistant }) {
  const hasTimelineEvents = assistant.timeline.some((t) => t.kind === "thinking" || t.kind === "tool_call");

  return (
    <div className="flex flex-col gap-0.5">
      {/* Timeline content */}
      <div className="flex flex-col gap-1">
        {assistant.timeline.map((entry, i) => (
          <TimelineNode key={i} entry={entry} hasTimeline={hasTimelineEvents} />
        ))}
      </div>

      {/* Bottom-left: model name, status, timer */}
      <div className="flex items-center gap-2 text-[10px] text-base-content/30">
        <span>{assistant.modelName}</span>
        <StatusBadge status={assistant.status} />
        <ElapsedTimer startTime={assistant.startTime} running={assistant.status !== "done" && assistant.status !== "error"} />
      </div>
    </div>
  );
}

/* ── Timeline node ──────────────────────────────────────── */

function TimelineNode({ entry, hasTimeline }: { entry: TimelineEntry; hasTimeline: boolean }) {
  if (entry.kind === "thinking") return <ThinkingNode entry={entry} />;
  if (entry.kind === "tool_call") return <ToolCallNode entry={entry} />;
  return <TextNode entry={entry} indented={hasTimeline} />;
}

/* ── Thinking ── */

function ThinkingNode({ entry }: { entry: ThinkingEntry }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  /* Auto-collapse when this thinking segment finishes */
  useEffect(() => {
    if (entry.done && detailsRef.current) detailsRef.current.open = false;
  }, [entry.done]);

  return (
    <details ref={detailsRef} open={!entry.done} className="ml-3 pl-3">
      <summary className="text-xs text-base-content/50 hover:text-base-content/70 cursor-pointer select-none list-none flex items-center gap-1 [&::-webkit-details-marker]:hidden">
        <CaretRight size={12} className="transition-transform [[open]>&]:rotate-90" />
        <span>{entry.done ? "thinking" : "thinking…"}</span>
      </summary>
      <div className="text-xs text-base-content/40 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">
        {entry.content}
      </div>
    </details>
  );
}

/* ── Tool call ── */

function ToolCallNode({ entry }: { entry: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-3 border-l-2 border-info/30 pl-3">
      <button
        type="button"
        className="text-xs text-info/70 hover:text-info flex items-center gap-1"
        onClick={() => setOpen(!open)}
      >
        <span>{entry.done ? "🔧" : "⏳"}</span>
        <span className="font-mono">{entry.name}</span>
        {!entry.done && <span className="loading loading-dots loading-xs" />}
      </button>
      {open && (
        <div className="text-xs mt-1 space-y-1 max-h-40 overflow-y-auto">
          <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/60">
            {tryFormatJson(entry.args)}
          </pre>
          {entry.result && (
            <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/60">
              {tryFormatJson(entry.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Text content ── */

function TextNode({ entry, indented }: { entry: TextEntry; indented: boolean }) {
  return (
    <div className={indented ? "ml-3 pl-3" : ""}>
      <div className="prose prose-sm max-w-none text-base-content [&_pre]:bg-base-200 [&_pre]:text-base-content/80 [&_code]:text-base-content/80">
        <Streamdown mode={entry.streaming ? "streaming" : "static"}>
          {entry.content}
        </Streamdown>
      </div>
    </div>
  );
}

/* ── Status badge ── */

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    sending: "Sending…",
    thinking: "Thinking…",
    tool_call: "Using tools…",
    replying: "Replying…",
    done: "",
    error: "Error",
  };
  const label = labels[status] ?? status;
  if (!label) return null;

  return (
    <span
      className={`badge badge-xs ${status === "error" ? "badge-error" : "badge-ghost"}`}
    >
      {status !== "done" && status !== "error" && (
        <span className="loading loading-dots loading-xs mr-1" />
      )}
      {label}
    </span>
  );
}

/* ── Elapsed timer ── */

function ElapsedTimer({ startTime, running }: { startTime: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime, running]);

  useEffect(() => {
    if (!running) {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }
  }, [running, startTime]);

  if (elapsed === 0 && running) return null;

  return (
    <span className="text-[10px] text-base-content/30">
      {elapsed}s
    </span>
  );
}

/* ── Util ── */

function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
