import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from "react";
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
  FilePlus,
  ChatText,
  CheckCircle,
  Hourglass,
  Brain,
  Wrench,
  GearSix,
  Lightning,
  Files,
  MagnifyingGlass,
  Paperclip,
  UploadSimple,
  ArrowsInSimple,
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { trpc } from "@/client/lib/trpc";
import toast from "react-hot-toast";
import { type ModelConfig, MODELS } from "./ModelSelector";
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
  ChatAnswerBody,
  ReplyEntry,
  AskEntry,
  AskQuestion,
  FinishEntry,
  AiSearchEntry,
  InjectedContextItem,
} from "@/shared/chat-types";
import {
  resolvePathToLeaf,
  findLatestLeaf,
  buildChildrenMap,
  getSiblingInfo,
} from "@/shared/chat-types";

const FILE_MUTATING_TOOLS = new Set(["edit_file", "edit_content"]);

/* ── Props ──────────────────────────────────────────────── */

type NoteItem = {
  id: string;
  name: string;
  content: string | null;
  active: boolean | null;
};

interface AgentChatProps {
  notebookId: string;
  notebookName: string;
  notebookDescription: string;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => void;
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  leafId: string | null;
  setLeafId: (id: string | null) => void;
  onOpenModelSelector: () => void;
  onOpenSessionSelector: () => void;
  draggedNoteIds: string[];
  droppedNoteIdsForChat: string[];
  clearDroppedNoteIds: () => void;
  notesList: NoteItem[];
}

/* ── Streaming assistant state ──────────────────────────── */

interface StreamingAssistant {
  id: string;
  parentId: string;
  modelName: string;
  modelProvider: string;
  startTime: number;
  status: "sending" | "thinking" | "tool_call" | "replying" | "waiting" | "done" | "error";
  timeline: TimelineEntry[];
  injectedContext?: InjectedContextItem[];
}

/* ── Main component ─────────────────────────────────────── */

export function AgentChat({
  notebookId,
  notebookName,
  notebookDescription,
  modelConfig,
  setModelConfig,
  currentSessionId,
  setCurrentSessionId,
  leafId,
  setLeafId,
  onOpenModelSelector,
  onOpenSessionSelector,
  draggedNoteIds,
  droppedNoteIdsForChat,
  clearDroppedNoteIds,
  notesList,
}: AgentChatProps) {
  const [allNodes, setAllNodes] = useState<ChatNode[]>([]);
  const [streamingAssistant, setStreamingAssistantState] = useState<StreamingAssistant | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedNoteIds, setAttachedNoteIds] = useState<Set<string>>(new Set());
  const [showAttachPopover, setShowAttachPopover] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressMode, setCompressMode] = useState<"native" | "soft">(() => {
    try {
      const stored = localStorage.getItem("ew-compress-mode");
      if (stored === "native" || stored === "soft") return stored;
    } catch {}
    return "native";
  });
  const [isChatUploading, setIsChatUploading] = useState(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const { setNodeRef, isOver } = useDroppable({ id: "chat-drop-zone" });

  /* Auto-select latest session on first load */
  useEffect(() => {
    if (currentSessionId || !sessions || sessions.length === 0) return;
    setCurrentSessionId(sessions[0].id);
  }, [sessions]);

  /* Load history */
  useEffect(() => {
    if (!currentSessionId || !notebookId) return;
    if (skipLoadHistoryRef.current) {
      skipLoadHistoryRef.current = false;
      return;
    }
    loadHistory(notebookId, currentSessionId);
  }, [currentSessionId, notebookId]);

  /** Restore ModelConfig from the last user node in loaded history */
  function restoreModelConfig(nodes: ChatNode[]) {
    const userNodes = nodes.filter((n): n is UserNode => n.role === "user");
    if (userNodes.length === 0) return;
    const last = userNodes.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const found = MODELS.find((m) => m.id === last.model);
    if (!found) return;
    const defaultMax = found.thinking ? 16384 : 8192;
    const defaults = found.thinking
      ? { thinkingLevel: "medium" as const, maxPerRound: defaultMax }
      : { temperature: 0.7, topP: 1, maxPerRound: defaultMax };
    const saved = last.modelParams;
    setModelConfig({
      model: found,
      params: saved
        ? { ...saved, maxPerRound: saved.maxPerRound ?? defaultMax }
        : defaults,
    });
  }

  async function loadHistory(nbId: string, sessionId: string) {
    try {
      const response = await fetch(
        `/api/chat/messages?notebookId=${encodeURIComponent(nbId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as ChatMessagesResponse;
      setAllNodes(data.nodes);
      restoreModelConfig(data.nodes);
      if (!leafId || !data.nodes.find((n) => n.id === leafId)) {
        setLeafId(data.leafId);
      }
    } catch {
      // silently fail
    }
  }

  /* Note drop */
  const handleNoteDrop = useCallback(
    (droppedIds: string[]) => {
      setAttachedNoteIds((prev) => {
        const next = new Set(prev);
        for (const id of droppedIds) next.add(id);
        return next;
      });
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [],
  );

  useEffect(() => {
    if (droppedNoteIdsForChat.length > 0) {
      handleNoteDrop(droppedNoteIdsForChat);
      clearDroppedNoteIds();
    }
  }, [droppedNoteIdsForChat, handleNoteDrop, clearDroppedNoteIds]);

  /* Auto-scroll */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activePath, streamingAssistant]);

  /* Upload files from chat input → auto-attach */
  const handleChatUpload = useCallback(
    async (fileList: FileList) => {
      if (fileList.length === 0) return;
      setIsChatUploading(true);
      try {
        const formData = new FormData();
        formData.append("notebookId", notebookId);
        for (const file of fileList) {
          formData.append("files", file);
        }
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          throw new Error(
            (errorBody as { error?: string } | null)?.error ?? "上传失败",
          );
        }
        const result = (await response.json()) as {
          uploaded: number;
          notes: Array<{ id: string; name: string }>;
        };
        setAttachedNoteIds((prev) => {
          const next = new Set(prev);
          for (const note of result.notes) next.add(note.id);
          return next;
        });
        toast.success(`已上传 ${result.uploaded} 个文件并附加`);
        utils.notes.listNotes.invalidate();
        utils.notes.listCategories.invalidate();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "上传失败");
      } finally {
        setIsChatUploading(false);
        if (chatFileInputRef.current) chatFileInputRef.current.value = "";
      }
    },
    [notebookId, utils],
  );

  /* Compress conversation */
  const updateCompressMode = useCallback((mode: "native" | "soft") => {
    setCompressMode(mode);
    try { localStorage.setItem("ew-compress-mode", mode); } catch {}
  }, []);

  const handleCompress = useCallback(
    async () => {
      if (!currentSessionId || isCompressing) return;
      setIsCompressing(true);
      try {
        const response = await fetch("/api/chat/compress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: currentSessionId,
            notebookId,
            mode: compressMode,
            model: modelConfig.model.id,
            leafId,
          }),
        });
        const result = (await response.json()) as {
          success: boolean;
          supported?: boolean;
          summary?: string;
        };
        if (compressMode === "native" && result.supported === false) {
          toast("当前模型不支持原生压缩，已回退到软压缩", { icon: "⚠️" });
          setIsCompressing(true);
          const fallbackResp = await fetch("/api/chat/compress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: currentSessionId,
              notebookId,
              mode: "soft",
              model: modelConfig.model.id,
              leafId,
            }),
          });
          const fallbackResult = (await fallbackResp.json()) as {
            success: boolean;
            summary?: string;
          };
          if (!fallbackResult.success) {
            toast.error(fallbackResult.summary ?? "压缩失败");
            return;
          }
          toast.success("对话已压缩（软压缩）");
          await loadHistory(notebookId, currentSessionId);
          return;
        }
        if (!result.success) {
          toast.error(result.summary ?? "压缩失败");
          return;
        }
        toast.success("对话已压缩");
        await loadHistory(notebookId, currentSessionId);
      } catch {
        toast.error("压缩失败");
      } finally {
        setIsCompressing(false);
      }
    },
    [currentSessionId, notebookId, modelConfig.model.id, leafId, isCompressing, compressMode],
  );

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
    const rawText = overrideText ?? input.trim();
    if (!rawText || isStreaming) return;

    let text = rawText;
    const currentAttached = [...attachedNoteIds];
    if (currentAttached.length > 0 && !overrideText) {
      const noteRefs = currentAttached.map((id) => `[${id}]`).join(", ");
      text = `用户引用了标记: ${noteRefs}\n---\n${rawText}`;
    }

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

    if (!overrideText) {
      setInput("");
      setAttachedNoteIds(new Set());
      setShowAttachPopover(false);
    }
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const activeNotes = notesList
      .filter((n) => n.active && n.content)
      .map((n) => ({ name: n.name, id: n.id }));

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
      const systemPrompt = [
        `You are an AI assistant for the notebook "${notebookName}".`,
        notebookDescription ? `Notebook description: ${notebookDescription}` : "",
      ].filter(Boolean).join(" ");

      const requestBody: ChatRequestBody = {
        sessionId,
        notebookId,
        message: text,
        parentId,
        model: modelConfig.model.id,
        modelName: modelConfig.model.name,
        modelProvider: modelConfig.model.provider,
        modelParams: modelConfig.params,
        systemPrompt,
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

      const appendInteractiveEntry = (tl: TimelineEntry[], tc: ToolCallEntry): TimelineEntry[] => {
        if (!["reply", "ask", "finish"].includes(tc.name)) return tl;
        const tcIndex = tl.findIndex((e) => e.kind === "tool_call" && e.toolCallId === tc.toolCallId);
        if (tcIndex < 0) return tl;
        const nextEntry = tl[tcIndex + 1];
        if (nextEntry && (nextEntry.kind === "reply" || nextEntry.kind === "ask" || nextEntry.kind === "finish")) {
          return tl;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(tc.args) as Record<string, unknown>;
        } catch {
          return tl;
        }
        const before = tl.slice(0, tcIndex + 1);
        const after = tl.slice(tcIndex + 1);
        switch (tc.name) {
          case "reply":
            return [...before, { kind: "reply", message: (parsed.message ?? "") as string }, ...after];
          case "ask": {
            updateStreaming((s) => ({ ...s, status: "waiting" }));
            return [
              ...before,
              {
                kind: "ask",
                questions: (parsed.questions ?? []) as AskQuestion[],
                resolved: false,
              },
              ...after,
            ];
          }
          case "finish": {
            /* Don't set status:"done" here — the stream is still open.
               finalizeStreaming() will set the terminal status once the SSE stream closes. */
            return [...before, { kind: "finish", message: (parsed.message ?? "") as string }, ...after];
          }
          default:
            return tl;
        }
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
                updateTimeline((tl) => {
                  const updated = tl.map((e) =>
                    e.kind === "tool_call" && e.toolCallId === tcId
                      ? { ...e, done: true, result: result ?? e.result }
                      : e,
                  );
                  const tc = updated.find(
                    (e): e is ToolCallEntry => e.kind === "tool_call" && e.toolCallId === tcId,
                  );
                  if (!tc) return updated;
                  return appendInteractiveEntry(updated, tc);
                });
                break;
              }
              case "TOOL_CALL_RESULT": {
                const tcId = evt.toolCallId as string;
                const content = (evt.content ?? evt.result ?? "") as string;
                updateTimeline((tl) => {
                  const updated = tl.map((e) =>
                    e.kind === "tool_call" && e.toolCallId === tcId
                      ? { ...e, done: true, result: content }
                      : e,
                  );
                  const tc = updated.find(
                    (e): e is ToolCallEntry => e.kind === "tool_call" && e.toolCallId === tcId,
                  );
                  if (!tc) return updated;
                  return appendInteractiveEntry(updated, tc);
                });

                const toolName = streamingAssistantRef.current?.timeline.find(
                  (e): e is ToolCallEntry => e.kind === "tool_call" && e.toolCallId === tcId,
                )?.name;
                if (toolName && FILE_MUTATING_TOOLS.has(toolName)) {
                  utils.notes.listNotes.invalidate();
                  utils.notes.listCategories.invalidate();
                }
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
                /* Status is set by finalizeStreaming() when the stream actually closes.
                   TanStack AI emits RUN_FINISHED between each agent-loop iteration,
                   so treating it as terminal here kills the timer mid-run. */
                break;
              }
              case "RUN_ERROR": {
                const errMsg = (evt.message ?? "Unknown error") as string;
                updateStreaming((s) => ({ ...s, status: "error" }));
                updateTimeline((tl) => [...tl, { kind: "text", content: `Error: ${errMsg}`, streaming: false }]);
                break;
              }
              case "CUSTOM": {
                const evtName = evt.name as string | undefined;
                const evtValue = evt.value as Record<string, unknown> | undefined;
                if (evtName === "injected_context" && evtValue && Array.isArray(evtValue.items)) {
                  updateStreaming((s) => ({
                    ...s,
                    injectedContext: evtValue.items as InjectedContextItem[],
                  }));
                }
                if (evtName === "ai_search" && evtValue) {
                  const searchEntry = evtValue as unknown as AiSearchEntry;
                  updateTimeline((tl) => [...tl, searchEntry]);
                }
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
        injectedContext: prev.injectedContext,
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

  async function submitAskAnswer(answers: Record<string, string | string[]>) {
    if (!currentSessionId) return;
    const body: ChatAnswerBody = { sessionId: currentSessionId, notebookId, answers };
    try {
      await fetch("/api/chat/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return;
    }
    setStreamingAssistant((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        status: "thinking",
        timeline: prev.timeline.map((e) =>
          e.kind === "ask" && !e.resolved ? { ...e, answers, resolved: true } : e,
        ),
      };
    });
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

  /* ── Detect pending ask from streaming timeline ────────── */
  const pendingAsk = useMemo(() => {
    if (!streamingAssistant || streamingAssistant.status !== "waiting") return null;
    const askEntry = streamingAssistant.timeline.find(
      (e): e is AskEntry => e.kind === "ask" && !e.resolved,
    );
    return askEntry ?? null;
  }, [streamingAssistant]);

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
                  onSubmitAnswer={submitAskAnswer}
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
                notebookId={notebookId}
              />
            );
          })
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Drop overlay */}
      {isOver && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none z-10">
          <span className="text-primary font-medium text-sm">拖放笔记以引用</span>
        </div>
      )}

      {/* Input Area */}
      {pendingAsk ? (
        <AskInputPanel
          entry={pendingAsk}
          onSubmitAnswer={submitAskAnswer}
        />
      ) : (
      <div className="border-t border-base-300 shrink-0">
        {/* Toolbar row */}
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-2">
          {/* Attach notes */}
          <div className="relative">
            <button
              type="button"
              className={`btn btn-ghost btn-sm gap-1 ${attachedNoteIds.size > 0 ? "text-primary" : "text-base-content/40"}`}
              onClick={() => setShowAttachPopover((v) => !v)}
              title="附加笔记"
            >
              <Paperclip size={18} />
              {attachedNoteIds.size > 0 && (
                <span className="badge badge-sm badge-primary">{attachedNoteIds.size}</span>
              )}
            </button>
            {showAttachPopover && (
              <div className="absolute bottom-full left-0 mb-1 w-64 bg-base-200 rounded-box shadow-lg border border-base-300 z-20 p-2 max-h-48 overflow-y-auto">
                {attachedNoteIds.size === 0 ? (
                  <div className="text-xs text-base-content/40 text-center py-2">
                    拖拽笔记到聊天区域以附加
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {[...attachedNoteIds].map((noteId) => {
                      const note = notesList.find((n) => n.id === noteId);
                      return (
                        <div
                          key={noteId}
                          className="flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-base-300"
                        >
                          <Files size={14} className="shrink-0" />
                          <span className="truncate flex-1">{note?.name ?? noteId}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-circle"
                            onClick={() =>
                              setAttachedNoteIds((prev) => {
                                const next = new Set(prev);
                                next.delete(noteId);
                                return next;
                              })
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Upload from chat */}
          <button
            type="button"
            className="btn btn-ghost btn-sm text-base-content/40"
            onClick={() => chatFileInputRef.current?.click()}
            disabled={isChatUploading}
            title="上传文件并附加"
          >
            {isChatUploading ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <UploadSimple size={18} />
            )}
          </button>
          <input
            ref={chatFileInputRef}
            type="file"
            className="hidden"
            multiple
            accept="text/*,.md,.txt,.csv,.json,.xml,.html,.htm,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.sh,.bash,.zsh,.py,.js,.ts,.jsx,.tsx,.css,.scss,.less,.sql,.r,.rs,.go,.java,.c,.cpp,.h,.hpp,.rb,.php,.swift,.kt,.scala,.lua,.pl,.tex,.bib,.org,.rst,.adoc,.nix"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleChatUpload(e.target.files);
              }
            }}
          />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Compress conversation - right aligned */}
          <select
            className="select select-sm select-ghost text-base-content/40 w-auto"
            value={compressMode}
            onChange={(e) => updateCompressMode(e.target.value as "native" | "soft")}
          >
            <option value="native">原生压缩</option>
            <option value="soft">软压缩</option>
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm text-base-content/40"
            disabled={!currentSessionId || isCompressing}
            onClick={() => handleCompress()}
            title="压缩对话"
          >
            {isCompressing ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <ArrowsInSimple size={18} />
            )}
          </button>
        </div>

        {/* Textarea */}
        <div className="relative px-3 pb-3">
          <textarea
            autoFocus
            ref={textareaRef}
            className="textarea textarea-bordered w-full pr-12 resize-none rounded-xl"
            rows={1}
            style={{ maxHeight: "6rem" }}
            placeholder="输入消息..."
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
            <button type="button" className="btn btn-error btn-sm absolute bottom-5 right-5" onClick={stopStreaming}>
              <Stop size={16} weight="bold" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm absolute bottom-5 right-5"
              onClick={() => sendMessage()}
              disabled={!input.trim() && attachedNoteIds.size === 0}
            >
              <PaperPlaneRight size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>
      )}
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
  notebookId,
}: {
  node: AssistantNode;
  notebookId: string;
}) {
  const [copied, setCopied] = useState(false);
  const hasTimelineEvents = node.timeline.some((t) => t.kind === "thinking" || t.kind === "tool_call" || t.kind === "ai_search");
  const createNoteMut = trpc.notes.createNote.useMutation();
  const updateNoteMut = trpc.notes.updateNote.useMutation();
  const utils = trpc.useUtils();

  function handleCopy() {
    navigator.clipboard.writeText(node.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleAddAsFile() {
    const name = node.content.slice(0, 40).replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-]/g, "").trim() || "untitled";
    const { id } = await createNoteMut.mutateAsync({ notebookId, categoryId: null, name });
    await updateNoteMut.mutateAsync({ id, content: node.content });
    await utils.notes.listNotes.invalidate();
  }

  /* Compute elapsed from timeline */
  const elapsed = node.timeline.length > 0
    ? Math.max(1, Math.round((Date.now() - node.createdAt) / 1000))
    : 0;

  const timelineSteps = node.timeline.filter((e) => e.kind !== "text");
  const textEntries = node.timeline.filter((e): e is TextEntry => e.kind === "text");

  return (
    <div className="flex flex-col gap-0.5">
      {node.injectedContext && node.injectedContext.length > 0 && (
        <ContextBanner items={node.injectedContext} />
      )}
      {timelineSteps.length > 0 && (
        <TimelineTrack entries={timelineSteps} />
      )}

      {textEntries.map((entry, i) => (
        <TextNode key={i} entry={entry} />
      ))}

      {/* Bottom-left: model name, elapsed, status, actions */}
      <div className="flex items-center gap-2 text-[10px] text-base-content/30">
        {node.modelName && <span>{node.modelName}</span>}
        {elapsed > 0 && <span>{elapsed}s</span>}
        {node.status === "error" && <StatusBadge status="error" />}

        <div className="flex items-center gap-0.5">
          <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={handleCopy} title="Copy">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button type="button" className="btn btn-ghost btn-xs btn-square" onClick={handleAddAsFile} title="Add as file">
            <FilePlus size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Streaming assistant block ──────────────────────────── */

function StreamingAssistantBlock({
  assistant,
  onSubmitAnswer,
}: {
  assistant: StreamingAssistant;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  const timelineSteps = assistant.timeline.filter((e) => e.kind !== "text");
  const textEntries = assistant.timeline.filter((e): e is TextEntry => e.kind === "text");

  return (
    <div className="flex flex-col gap-0.5">
      {assistant.injectedContext && assistant.injectedContext.length > 0 && (
        <ContextBanner items={assistant.injectedContext} />
      )}
      {timelineSteps.length > 0 && (
        <TimelineTrack entries={timelineSteps} streamingStatus={assistant.status} onSubmitAnswer={onSubmitAnswer} />
      )}

      {textEntries.map((entry, i) => (
        <TextNode key={i} entry={entry} />
      ))}

      <div className="flex items-center gap-2 text-[10px] text-base-content/30">
        <span>{assistant.modelName}</span>
        <StatusBadge status={assistant.status} />
        <ElapsedTimer startTime={assistant.startTime} running={assistant.status !== "done" && assistant.status !== "error"} />
      </div>
    </div>
  );
}

/* ── Context banner (injected notes) ────────────────────── */

function ContextBanner({ items }: { items: InjectedContextItem[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-0.5 text-[11px] text-base-content/50">
      <button
        type="button"
        className="flex items-center gap-1.5 hover:text-base-content/70 transition-colors w-fit"
        onClick={() => setExpanded((v) => !v)}
      >
        <Files size={13} weight="duotone" />
        <span>参考了 {items.length} 篇笔记</span>
        <CaretDown size={10} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="pl-5 flex flex-col gap-0.5">
          {items.map((item) => (
            <div key={item.name} className="flex items-center gap-1 text-[10px] text-base-content/40">
              <span className="truncate max-w-[200px]">{item.name}</span>
              {item.snippet && (
                <span className="truncate max-w-[300px] italic">{item.snippet}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Timeline track (vertical dot+line) ─────────────────── */

function TimelineTrack({
  entries,
  streamingStatus,
  onSubmitAnswer,
}: {
  entries: TimelineEntry[];
  streamingStatus?: string;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  // Group consecutive tool_call entries with the same name
  const grouped = useMemo(() => {
    const result: (TimelineEntry | { kind: "tool_call_group"; name: string; calls: ToolCallEntry[] })[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      if (entry.kind === "tool_call") {
        const groupStart = i;
        while (
          i + 1 < entries.length &&
          entries[i + 1].kind === "tool_call" &&
          (entries[i + 1] as ToolCallEntry).name === entry.name
        ) {
          i++;
        }
        const groupEnd = i;
        if (groupEnd > groupStart) {
          // 2+ consecutive same-name tool calls → group
          const calls = entries.slice(groupStart, groupEnd + 1) as ToolCallEntry[];
          result.push({ kind: "tool_call_group", name: entry.name, calls });
        } else {
          result.push(entry);
        }
      } else {
        result.push(entry);
      }
      i++;
    }
    return result;
  }, [entries]);

  return (
    <div className="relative pl-5 py-1">
      {/* Vertical line */}
      <div className="absolute left-[7px] top-3 bottom-3 w-px bg-base-content/10" />

      <div className="flex flex-col gap-0.5">
        {grouped.map((entry, i) => (
          entry.kind === "tool_call_group"
            ? <ToolCallGroupStep key={i} group={entry} isLast={i === grouped.length - 1} />
            : <TimelineStep
                key={i}
                entry={entry}
                isLast={i === grouped.length - 1}
                streamingStatus={streamingStatus}
                onSubmitAnswer={onSubmitAnswer}
              />
        ))}
      </div>
    </div>
  );
}

/* ── Single timeline step (dot + content) ────────────────── */

function TimelineStep({
  entry,
  isLast,
  streamingStatus,
  onSubmitAnswer,
}: {
  entry: TimelineEntry;
  isLast: boolean;
  streamingStatus?: string;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  const dotIcon = timelineDotIcon(entry);

  return (
    <div className="relative flex items-start gap-2 min-h-[20px]">
      {/* Dot */}
      <div className="absolute -left-5 top-[3px] flex items-center justify-center w-[15px] h-[15px] rounded-full bg-base-100 z-[1]">
        {dotIcon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <TimelineStepContent entry={entry} streamingStatus={streamingStatus} onSubmitAnswer={onSubmitAnswer} />
      </div>
    </div>
  );
}

/* ── Grouped tool calls (consecutive same-name) ──────────── */

function ToolCallGroupStep({
  group,
  isLast,
}: {
  group: { kind: "tool_call_group"; name: string; calls: ToolCallEntry[] };
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const runningCount = group.calls.filter((c) => !c.done).length;
  const totalCount = group.calls.length;
  const allDone = runningCount === 0;

  const dotIcon = allDone
    ? <Wrench size={11} className="text-base-content/30" />
    : <GearSix size={11} className="text-info/70 animate-spin" />;

  return (
    <div className="relative flex items-start gap-2 min-h-[20px]">
      {/* Dot */}
      <div className="absolute -left-5 top-[3px] flex items-center justify-center w-[15px] h-[15px] rounded-full bg-base-100 z-[1]">
        {dotIcon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div>
          <button
            type="button"
            className="text-xs text-base-content/50 hover:text-base-content/70 flex items-center gap-1 leading-relaxed"
            onClick={() => setOpen(!open)}
          >
            <span className="font-mono">{group.name}</span>
            <span className="text-base-content/30">
              ({allDone ? `${totalCount}` : `${runningCount}运行中/${totalCount}`})
            </span>
            {!allDone && <span className="loading loading-dots loading-xs" />}
            <CaretRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
          </button>
          {open && (
            <div className="text-xs mt-1 space-y-2 max-h-60 overflow-y-auto">
              {group.calls.map((call, i) => (
                <ToolCallGroupItem key={call.toolCallId || i} entry={call} index={i} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolCallGroupItem({ entry, index }: { entry: ToolCallEntry; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l border-base-content/10 pl-2">
      <button
        type="button"
        className="text-[11px] text-base-content/40 hover:text-base-content/60 flex items-center gap-1"
        onClick={() => setOpen(!open)}
      >
        <span className="text-base-content/30 truncate max-w-[200px]">{toolCallSummary(entry) || `#${index + 1}`}</span>
        {!entry.done && <span className="loading loading-dots loading-xs" />}
        {entry.done && <Check size={9} className="text-success/50" />}
        <CaretRight size={9} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="text-xs mt-1 space-y-1 max-h-40 overflow-y-auto">
          <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/50 text-[11px]">
            {tryFormatJson(entry.args)}
          </pre>
          {entry.result && (
            <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/50 text-[11px]">
              {tryFormatJson(entry.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function timelineDotIcon(entry: TimelineEntry) {
  switch (entry.kind) {
    case "thinking":
      return <Brain size={11} weight={entry.done ? "regular" : "fill"} className={entry.done ? "text-base-content/30" : "text-base-content/50 animate-pulse"} />;
    case "tool_call":
      return entry.done
        ? <Wrench size={11} className="text-base-content/30" />
        : <GearSix size={11} className="text-info/70 animate-spin" />;
    case "ai_search":
      return <MagnifyingGlass size={11} weight="duotone" className="text-info/60" />;
    case "reply":
      return <ChatText size={11} className="text-base-content/30" />;
    case "ask":
      return <Lightning size={11} weight="fill" className="text-warning" />;
    case "finish":
      return <CheckCircle size={11} weight="fill" className="text-success" />;
    default:
      return <div className="w-1.5 h-1.5 rounded-full bg-base-content/20" />;
  }
}

function TimelineStepContent({
  entry,
  streamingStatus,
  onSubmitAnswer,
}: {
  entry: TimelineEntry;
  streamingStatus?: string;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  switch (entry.kind) {
    case "thinking":
      return <ThinkingContent entry={entry} />;
    case "tool_call":
      return <ToolCallContent entry={entry} />;
    case "ai_search":
      return <AiSearchContent entry={entry} />;
    case "reply":
      return <span className="text-xs text-base-content/60 leading-relaxed">{entry.message}</span>;
    case "ask":
      return <AskContent entry={entry} isWaiting={streamingStatus === "waiting"} />;
    case "finish":
      return <span className="text-xs text-success leading-relaxed">{entry.message}</span>;
    default:
      return null;
  }
}

/* ── Thinking (collapsible) ─────────────────────────────── */

function ThinkingContent({ entry }: { entry: ThinkingEntry }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (entry.done && detailsRef.current) detailsRef.current.open = false;
  }, [entry.done]);

  return (
    <details ref={detailsRef} open={!entry.done}>
      <summary className="text-xs text-base-content/40 hover:text-base-content/60 cursor-pointer select-none list-none flex items-center gap-1 [&::-webkit-details-marker]:hidden leading-relaxed">
        <CaretRight size={10} className="transition-transform [[open]>&]:rotate-90 shrink-0" />
        <span>{entry.done ? "思考完成" : "思考中…"}</span>
      </summary>
      <div className="text-xs text-base-content/30 mt-1 whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
        {entry.content}
      </div>
    </details>
  );
}

/* ── Tool call (collapsible args/result) ─────────────────── */

function ToolCallContent({ entry }: { entry: ToolCallEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        className="text-xs text-base-content/50 hover:text-base-content/70 flex items-center gap-1 leading-relaxed"
        onClick={() => setOpen(!open)}
      >
        <span className="font-mono">{entry.name}</span>
        {toolCallSummary(entry) && <span className="text-base-content/30 truncate max-w-[200px]">{toolCallSummary(entry)}</span>}
        {!entry.done && <span className="loading loading-dots loading-xs" />}
        <CaretRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="text-xs mt-1 space-y-1 max-h-40 overflow-y-auto">
          <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/50 text-[11px]">
            {tryFormatJson(entry.args)}
          </pre>
          {entry.result && (
            <pre className="bg-base-200 rounded p-1.5 overflow-x-auto text-base-content/50 text-[11px]">
              {tryFormatJson(entry.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── AI Search results (collapsible) ─────────────────────── */

function AiSearchContent({ entry }: { entry: AiSearchEntry }) {
  const [open, setOpen] = useState(false);
  const fileCount = entry.results.length;

  return (
    <div>
      <button
        type="button"
        className="text-xs text-base-content/50 hover:text-base-content/70 flex items-center gap-1 leading-relaxed"
        onClick={() => setOpen(!open)}
      >
        <span className="font-mono">自动AI检索</span>
        {entry.round > 1 && <span className="text-[10px] text-base-content/30">第{entry.round}轮</span>}
        <span className="text-base-content/30">·</span>
        <span>{fileCount} 个文件</span>
        <CaretRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="text-xs mt-1.5 space-y-1.5 max-h-60 overflow-y-auto">
          {/* Search query */}
          <div className="bg-base-200 rounded p-1.5 text-[11px] text-base-content/40">
            <span className="text-base-content/50 font-medium">query: </span>
            <span className="break-all">{entry.query}</span>
          </div>
          {/* Result files */}
          {entry.results.map((item, i) => (
            <div key={`${item.fileId}-${i}`} className="bg-base-200 rounded p-2">
              <div className="flex items-center gap-1.5 text-base-content/60 mb-0.5">
                <Files size={10} weight="duotone" />
                <span className="font-medium truncate max-w-[200px]">{item.filename}</span>
                <span className="text-[10px] text-base-content/30 ml-auto">
                  相关度 {(item.score * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-[11px] text-base-content/40 line-clamp-4 leading-relaxed whitespace-pre-wrap">
                {item.snippet}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Text content (response body, outside timeline) ──────── */

function TextNode({ entry }: { entry: TextEntry }) {
  return (
    <div className="py-2">
      <div className="prose prose-sm max-w-none text-base-content [&_pre]:bg-base-200 [&_pre]:text-base-content/80 [&_code]:text-base-content/80">
        <Streamdown mode={entry.streaming ? "streaming" : "static"}>
          {entry.content}
        </Streamdown>
      </div>
    </div>
  );
}

/* ── Reply (progress message from agent) ─────────────────── */
/* (handled inline in TimelineStepContent) */

/* ── Ask (agent asks user a question) ────────────────────── */

function AskContent({
  entry,
  isWaiting,
}: {
  entry: AskEntry;
  isWaiting: boolean;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  if (entry.resolved) {
    return (
      <div className="space-y-1.5">
        {entry.questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-0.5">
            <span className="text-xs text-base-content/60">{q.question}</span>
            <div className="flex flex-wrap gap-1">
              {(Array.isArray(entry.answers?.[q.id])
                ? (entry.answers![q.id] as string[])
                : [entry.answers?.[q.id]].filter(Boolean) as string[]
              ).map((a) => (
                <span key={a} className="badge badge-xs badge-primary">{a}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Pending — show a hint that the input area below has the ask UI
  return (
    <div className="text-xs text-warning/80 flex items-center gap-1">
      <Hourglass size={12} weight="fill" className="animate-pulse" />
      <span>等待回答...</span>
    </div>
  );
}

/* ── Ask input panel (replaces input area when ask is pending) ── */

function AskInputPanel({
  entry,
  onSubmitAnswer,
}: {
  entry: AskEntry;
  onSubmitAnswer?: (answers: Record<string, string | string[]>) => void;
}) {
  const [activeTab, setActiveTab] = useState(0);
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState("");
  const questions = entry.questions;
  const singleQuestion = questions.length === 1;
  const currentQ = questions[activeTab];

  function toggleMulti(questionId: string, label: string) {
    setSelections((prev) => {
      const current = (prev[questionId] ?? []) as string[];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...prev, [questionId]: next };
    });
  }

  function selectSingle(questionId: string, label: string) {
    setSelections((prev) => {
      const current = prev[questionId];
      // Toggle off if already selected
      if (current === label) {
        const next = { ...prev };
        delete next[questionId];
        return next;
      }
      return { ...prev, [questionId]: label };
    });
  }

  function handleSubmit() {
    // Build answers: use freeText as override if provided, otherwise use selections
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      if (freeText.trim() && singleQuestion) {
        // For single question, free text overrides selection
        answers[q.id] = freeText.trim();
      } else {
        answers[q.id] = selections[q.id] ?? "";
      }
    }
    onSubmitAnswer?.(answers);
  }

  function handleFreeTextKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const hasAnswer = singleQuestion
    ? !!(freeText.trim() || selections[currentQ?.id])
    : questions.every((q) => {
        const sel = selections[q.id];
        return sel && (typeof sel === "string" ? sel.length > 0 : sel.length > 0);
      });

  return (
    <div className="border-t border-warning/30 bg-warning/5 shrink-0">
      {/* Tab navigation for multiple questions */}
      {!singleQuestion && (
        <div className="flex items-center gap-0.5 px-3 pt-2 overflow-x-auto">
          {questions.map((q, i) => {
            const answered = !!selections[q.id];
            return (
              <button
                key={q.id}
                type="button"
                className={`btn btn-xs ${activeTab === i ? "btn-warning" : answered ? "btn-ghost text-success" : "btn-ghost text-base-content/40"}`}
                onClick={() => setActiveTab(i)}
              >
                {answered && <Check size={10} className="text-success" />}
                <span className="truncate max-w-[120px]">问题 {i + 1}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Current question + options */}
      {currentQ && (
        <div className="px-3 pt-2 pb-1">
          <div className="text-sm font-medium text-base-content/80 mb-2">{currentQ.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {currentQ.options.map((opt) => {
              const selected = currentQ.multi
                ? ((selections[currentQ.id] ?? []) as string[]).includes(opt.label)
                : selections[currentQ.id] === opt.label;

              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`btn btn-sm ${selected ? "btn-warning" : "btn-outline btn-ghost"}`}
                  onClick={() =>
                    currentQ.multi
                      ? toggleMulti(currentQ.id, opt.label)
                      : selectSingle(currentQ.id, opt.label)
                  }
                  title={opt.description}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Free text input + submit */}
      <div className="px-3 pb-3 pt-1 flex items-end gap-2">
        <textarea
          autoFocus
          className="textarea textarea-bordered flex-1 resize-none rounded-xl text-sm"
          rows={1}
          style={{ maxHeight: "4rem" }}
          placeholder="用自然语言回答或补充说明..."
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={handleFreeTextKeyDown}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = `${Math.min(target.scrollHeight, 64)}px`;
          }}
        />
        {singleQuestion ? (
          <button
            type="button"
            className="btn btn-warning btn-sm"
            disabled={!hasAnswer}
            onClick={handleSubmit}
          >
            <Check size={14} weight="bold" />
            回答完毕
          </button>
        ) : activeTab < questions.length - 1 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setActiveTab((t) => Math.min(t + 1, questions.length - 1))}
          >
            下一题
            <CaretRight size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-warning btn-sm"
            disabled={!hasAnswer}
            onClick={handleSubmit}
          >
            <Check size={14} weight="bold" />
            回答完毕
          </button>
        )}
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
    waiting: "Waiting",
    done: "",
    error: "Error",
  };
  const label = labels[status] ?? status;
  if (!label) return null;

  const badgeClass =
    status === "error"
      ? "badge-error"
      : status === "waiting"
        ? "badge-warning"
        : "badge-ghost";

  return (
    <span className={`badge badge-xs ${badgeClass}`}>
      {status === "waiting" ? (
        <Hourglass size={10} className="mr-1" />
      ) : status !== "done" && status !== "error" ? (
        <span className="loading loading-dots loading-xs mr-1" />
      ) : null}
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

/** Extract a short human-readable summary from tool call args for inline preview */
function toolCallSummary(entry: ToolCallEntry): string {
  try {
    const args = JSON.parse(entry.args);
    switch (entry.name) {
      case "search_file":
        return args.query ? `"${args.query}"` : "";
      case "read_file": {
        // Try to extract filename from the tool result
        let label = "";
        if (entry.result) {
          try {
            const res = JSON.parse(entry.result);
            if (res.filename && res.filename !== "NOT_FOUND") label = res.filename;
          } catch {}
        }
        if (!label) label = (args.file_id ?? "").slice(0, 8);
        const range = args.line_start && args.line_end ? ` L${args.line_start}-${args.line_end}` : args.line_start ? ` L${args.line_start}+` : "";
        return label + range;
      }
      case "edit_file":
        return [args.new_filename, args.new_tag].filter(Boolean).join(" → ") || (args.file_id ?? "").slice(0, 8);
      case "edit_content": {
        const hunks = typeof args.diff === "string" ? (args.diff.match(/^@@/gm) ?? []).length : 0;
        return `${hunks} hunk${hunks !== 1 ? "s" : ""}`;
      }
      case "web_search":
        return args.query ? `"${args.query}"` : "";
      case "web_page_read":
        return args.url ? new URL(args.url).hostname : "";
      default: {
        // Generic: pick the first short string value
        const vals = Object.values(args).filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 60);
        return vals[0] ?? "";
      }
    }
  } catch {
    return "";
  }
}

function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
