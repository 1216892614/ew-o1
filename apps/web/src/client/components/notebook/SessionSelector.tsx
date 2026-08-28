import { useState, useRef } from "react";
import { X, Plus, ChatCircle } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";

interface SessionSelectorProps {
  notebookId: string;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  currentSessionId?: string;
}

function formatRelativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

export function SessionSelector({
  notebookId,
  onSelect,
  onClose,
  currentSessionId,
}: SessionSelectorProps) {
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const newNameRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  const { data: sessions = [] } = trpc.notes.listSessions.useQuery({
    notebookId,
    search: search || undefined,
  });

  const createSession = trpc.notes.createSession.useMutation({
    onSuccess: (created) => {
      utils.notes.listSessions.invalidate({ notebookId });
      setIsCreating(false);
      setNewName("");
      onSelect(created.id);
    },
  });

  function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    createSession.mutate({ notebookId, name: trimmed });
  }

  function handleNewSessionClick() {
    setIsCreating(true);
    setTimeout(() => newNameRef.current?.focus(), 0);
  }

  return (
    <dialog className="modal modal-open">
      <div className="modal-box w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Sessions</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleNewSessionClick}
            >
              <Plus size={14} />
              New Session
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <input
          type="text"
          className="input input-bordered input-sm w-full mb-3"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="overflow-y-auto max-h-96">
          {isCreating && (
            <div className="p-3 border border-primary rounded-lg mb-2">
              <input
                ref={newNameRef}
                type="text"
                className="input input-bordered input-sm w-full"
                placeholder="Session name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") {
                    setIsCreating(false);
                    setNewName("");
                  }
                }}
                disabled={createSession.isPending}
              />
            </div>
          )}

          {sessions.length === 0 && !isCreating && (
            <div className="text-center text-base-content/50 py-8 text-sm">
              No sessions found
            </div>
          )}

          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`w-full text-left p-3 hover:bg-base-200 rounded-lg cursor-pointer border mb-2 transition-colors ${
                session.id === currentSessionId
                  ? "border-primary bg-base-200"
                  : "border-base-300"
              }`}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex items-center gap-2">
                <ChatCircle size={16} className="text-base-content/60 shrink-0" />
                <span className="font-medium text-sm truncate">
                  {session.name}
                </span>
              </div>
              <div className="text-xs text-base-content/60 mt-1 ml-6">
                {session.lastMessageAt
                  ? formatRelativeTime(session.lastMessageAt)
                  : "No messages"}
                {session.modelName && (
                  <span className="ml-2">· {session.modelName}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop" onClick={onClose}>
        <button type="button">close</button>
      </form>
    </dialog>
  );
}
