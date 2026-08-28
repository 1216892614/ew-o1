import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { createPortal } from "react-dom";
import { PencilSimple } from "@phosphor-icons/react";
import { Provider as JotaiProvider } from "jotai";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, pointerWithin } from "@dnd-kit/core";
import { trpc } from "@/client/lib/trpc";
import { NotesSidebar } from "@/client/components/notebook/NotesSidebar";
import { AgentChat } from "@/client/components/notebook/AgentChat";
import { EditorPanel } from "@/client/components/notebook/EditorPanel";
import { ModelSelector, type ModelInfo, MODELS } from "@/client/components/notebook/ModelSelector";
import { SessionSelector } from "@/client/components/notebook/SessionSelector";
import { NotebookMetaModal } from "@/client/components/notebook/NotebookMetaModal";
import { useAtom, useSetAtom } from "jotai";
import { openedNoteIdAtom, selectedNoteIdsAtom } from "@/client/components/notebook/state";

export const Route = createFileRoute("/notebook/$id")({
  component: NotebookPage,
});

function NotebookPage() {
  const { id } = Route.useParams();

  return (
    <JotaiProvider>
      <NotebookPageInner notebookId={id} />
    </JotaiProvider>
  );
}

function NotebookPageInner({ notebookId }: { notebookId: string }) {
  const { data: notebook } = trpc.notes.getNotebook.useQuery({ id: notebookId });
  const { data: notesList } = trpc.notes.listNotes.useQuery({ notebookId });
  const batchUpdate = trpc.notes.batchUpdateNotes.useMutation();
  const utils = trpc.useUtils();

  const [showMetaModal, setShowMetaModal] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [currentModel, setCurrentModel] = useState<ModelInfo>(MODELS[0]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [draggedNoteIds, setDraggedNoteIds] = useState<string[]>([]);

  const [selectedNoteIds, setSelectedNoteIds] = useAtom(selectedNoteIdsAtom);
  const setOpenedNoteId = useSetAtom(openedNoteIdAtom);

  function handleDragStart(event: DragStartEvent) {
    const noteId = event.active.id as string;
    if (selectedNoteIds.has(noteId)) {
      setDraggedNoteIds([...selectedNoteIds]);
    } else {
      setDraggedNoteIds([noteId]);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { over } = event;
    if (!over) {
      setDraggedNoteIds([]);
      return;
    }

    const dropId = over.id as string;

    if (dropId === "editor-drop-zone") {
      // Open first dragged note in editor
      if (draggedNoteIds.length > 0) {
        setOpenedNoteId(draggedNoteIds[0]);
      }
    } else if (dropId === "chat-drop-zone") {
      // Handled by AgentChat's onDrop
    } else if (dropId.startsWith("category-")) {
      // Move notes to category
      const categoryId = dropId.replace("category-", "");
      batchUpdate.mutate(
        { ids: draggedNoteIds, categoryId: categoryId === "uncategorized" ? null : categoryId },
        { onSuccess: () => utils.notes.listNotes.invalidate() },
      );
    }

    setDraggedNoteIds([]);
  }

  if (!notebook) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  const draggedNote = notesList?.find((n) => n.id === draggedNoteIds[0]);

  return (
    <DndContext
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {document.getElementById("header-center") &&
        createPortal(
          <button
            type="button"
            onClick={() => setShowMetaModal(true)}
            className="flex items-center gap-1.5 cursor-pointer hover:text-primary transition-colors"
          >
            <span className="font-semibold text-sm truncate max-w-xs">
              {notebook.name}
            </span>
            <PencilSimple size={14} className="text-base-content/50" />
          </button>,
          document.getElementById("header-center")!,
        )}

      <div className="flex flex-1 overflow-hidden">
          {/* Left: Notes Sidebar */}
          <div className="w-80 border-r border-base-300 flex flex-col overflow-hidden">
            <NotesSidebar notebookId={notebookId} />
          </div>

          {/* Center: Agent Chat */}
          <div className="flex-1 flex flex-col overflow-hidden border-r border-base-300">
            <AgentChat
              notebookId={notebookId}
              currentModel={currentModel}
              currentSessionId={currentSessionId}
              onOpenModelSelector={() => setShowModelSelector(true)}
              onOpenSessionSelector={() => setShowSessionSelector(true)}
              draggedNoteIds={draggedNoteIds}
              notesList={notesList ?? []}
            />
          </div>

          {/* Right: Editor */}
          <div className="w-[40%] min-w-[360px] flex flex-col overflow-hidden">
            <EditorPanel notebookId={notebookId} />
          </div>
        </div>

      <DragOverlay>
        {draggedNoteIds.length > 0 && (
          <div className="bg-base-200 border border-base-300 rounded-lg px-3 py-2 shadow-lg text-sm">
            {draggedNoteIds.length > 1
              ? `${draggedNoteIds.length} notes`
              : draggedNote?.name ?? "Note"}
          </div>
        )}
      </DragOverlay>

      {/* Modals */}
      {showMetaModal && (
        <NotebookMetaModal
          notebook={notebook}
          onClose={() => setShowMetaModal(false)}
        />
      )}
      {showModelSelector && (
        <ModelSelector
          currentModelId={currentModel.id}
          onSelect={(m) => {
            setCurrentModel(m);
            setShowModelSelector(false);
          }}
          onClose={() => setShowModelSelector(false)}
        />
      )}
      {showSessionSelector && (
        <SessionSelector
          notebookId={notebookId}
          currentSessionId={currentSessionId ?? undefined}
          onSelect={(sid) => {
            setCurrentSessionId(sid);
            setShowSessionSelector(false);
          }}
          onClose={() => setShowSessionSelector(false)}
        />
      )}
    </DndContext>
  );
}
