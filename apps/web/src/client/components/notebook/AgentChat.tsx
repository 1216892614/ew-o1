import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChatCircleDots, PaperPlaneRight, CaretDown } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";
import type { ModelInfo } from "./ModelSelector";

type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

type NoteItem = {
  id: string;
  name: string;
  [key: string]: unknown;
};

interface AgentChatProps {
  notebookId: string;
  currentModel: ModelInfo;
  currentSessionId: string | null;
  onOpenModelSelector: () => void;
  onOpenSessionSelector: () => void;
  draggedNoteIds: string[];
  notesList: NoteItem[];
}

export function AgentChat({
  notebookId,
  currentModel,
  currentSessionId,
  onOpenModelSelector,
  onOpenSessionSelector,
  draggedNoteIds,
  notesList,
}: AgentChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevDraggedRef = useRef<string[]>([]);

  const { data: sessions } = trpc.notes.listSessions.useQuery({ notebookId });
  const currentSession = sessions?.find((s) => s.id === currentSessionId);

  const { setNodeRef, isOver } = useDroppable({ id: "chat-drop-zone" });

  // Handle note drops
  useEffect(() => {
    // Detect when draggedNoteIds goes from non-empty to empty (drop completed)
    // The parent DndContext handles actual drop events, but we can check
    // if isOver was true and items were dragged
  }, [draggedNoteIds]);

  // We rely on the parent's onDragEnd to detect the actual drop onto this zone.
  // But since we're a droppable, we'll handle adding context via a callback effect.
  // The parent route detects over.id === 'chat-drop-zone' — let's expose an effect:
  const handleNoteDrop = useCallback(
    (noteIds: string[]) => {
      const notes = notesList.filter((n) => noteIds.includes(n.id));
      for (const note of notes) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Note added to context: ${note.name}`,
          },
        ]);
      }
    },
    [notesList],
  );

  // Watch for external drop signal: when draggedNoteIds becomes empty and we were the target
  useEffect(() => {
    if (
      prevDraggedRef.current.length > 0 &&
      draggedNoteIds.length === 0 &&
      isOver
    ) {
      handleNoteDrop(prevDraggedRef.current);
    }
    prevDraggedRef.current = draggedNoteIds;
  }, [draggedNoteIds, isOver, handleNoteDrop]);

  // Auto-scroll on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage() {
    const text = input.trim();
    if (!text) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Mock assistant response
    setTimeout(() => {
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "This is a placeholder response. Agent chat will be connected to AI SDK.",
      };
      setMessages((prev) => [...prev, assistantMsg]);
    }, 500);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div ref={setNodeRef} className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 border-b border-base-300 flex items-center gap-3 px-3 shrink-0">
        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1 font-normal"
          onClick={onOpenModelSelector}
        >
          <span className="truncate max-w-[120px]">{currentModel.name}</span>
          <span className="badge badge-xs badge-outline">{currentModel.provider}</span>
          <CaretDown size={12} />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1 font-normal"
          onClick={onOpenSessionSelector}
        >
          <span className="truncate max-w-[140px]">
            {currentSession?.name ?? "New Chat"}
          </span>
          <CaretDown size={12} />
        </button>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/40 gap-2">
            <ChatCircleDots size={48} weight="thin" />
            <span className="text-sm">Start a conversation</span>
          </div>
        ) : (
          messages.map((msg) =>
            msg.role === "system" ? (
              <div key={msg.id} className="text-xs text-base-content/50 text-center italic py-1">
                {msg.content}
              </div>
            ) : (
              <div
                key={msg.id}
                className={`chat ${msg.role === "user" ? "chat-end" : "chat-start"}`}
              >
                <div
                  className={`chat-bubble ${
                    msg.role === "user"
                      ? "chat-bubble-primary"
                      : "chat-bubble-neutral"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ),
          )
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Drop overlay indicator */}
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
          <button
            type="button"
            className="btn btn-primary btn-sm absolute bottom-2 right-2"
            onClick={sendMessage}
            disabled={!input.trim()}
          >
            <PaperPlaneRight size={16} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
