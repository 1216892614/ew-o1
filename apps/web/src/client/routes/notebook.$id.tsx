import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { PencilSimple, X, FolderSimplePlus, MagnifyingGlass, ShareNetwork } from "@phosphor-icons/react";
import { Provider as JotaiProvider } from "jotai";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, KeyboardSensor, useSensor, useSensors, pointerWithin } from "@dnd-kit/core";
import { trpc } from "@/client/lib/trpc";
import { NotesSidebar } from "@/client/components/notebook/NotesSidebar";
import { AgentChat } from "@/client/components/notebook/AgentChat";
import { EditorPanel } from "@/client/components/notebook/EditorPanel";
import { ModelSelector, type ModelConfig, getDefaultModelConfig } from "@/client/components/notebook/ModelSelector";
import { SessionSelector } from "@/client/components/notebook/SessionSelector";
import { NotebookMetaModal } from "@/client/components/notebook/NotebookMetaModal";
import { TimeMachineModal } from "@/client/components/notebook/TimeMachineModal";
import { ShareModal } from "@/client/components/notebook/ShareModal";
import { useAtom, useSetAtom } from "jotai";
import { openedNoteIdAtom, selectedNoteIdsAtom, type ChatSessionState } from "@/client/components/notebook/state";
import { z } from "zod";

const notebookSearchSchema = z.object({
  leaf: z.string().optional(),
});

export const Route = createFileRoute("/notebook/$id")({
  component: NotebookPage,
  validateSearch: notebookSearchSchema,
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
  const utils = trpc.useUtils();
  const initFromR2Mutation = trpc.notes.initFromR2.useMutation();
  const [r2Initialized, setR2Initialized] = useState(false);

  useEffect(() => {
    initFromR2Mutation.mutate(
      { notebookId },
      {
        onSuccess: () => {
          setR2Initialized(true);
          utils.notes.listNotes.invalidate();
          utils.notes.listCategories.invalidate();
          utils.notes.getNotebook.invalidate();
        },
        onError: () => {
          setR2Initialized(true);
        },
      },
    );
  }, [notebookId]);

  const { data: notebook } = trpc.notes.getNotebook.useQuery({ id: notebookId }, { enabled: r2Initialized });
  const { data: notesList } = trpc.notes.listNotes.useQuery({ notebookId }, { enabled: r2Initialized });
  const batchUpdate = trpc.notes.batchUpdateNotes.useMutation();
  const navigate = Route.useNavigate();

  const { leaf: leafFromUrl } = Route.useSearch();

  const [showMetaModal, setShowMetaModal] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [showTimeMachine, setShowTimeMachine] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(getDefaultModelConfig());
  const [sessionState, setSessionState] = useState<ChatSessionState>({ type: "init" });
  const [draggedNoteIds, setDraggedNoteIds] = useState<string[]>([]);
  const [droppedNoteIdsForChat, setDroppedNoteIdsForChat] = useState<string[]>([]);
  const [pendingCategoryNoteIds, setPendingCategoryNoteIds] = useState<string[] | null>(null);
  const [leafId, setLeafIdState] = useState<string | null>(leafFromUrl ?? null);

  const [selectedNoteIds, setSelectedNoteIds] = useAtom(selectedNoteIdsAtom);
  const setOpenedNoteId = useSetAtom(openedNoteIdAtom);

  const setLeafId = useCallback(
    (id: string | null) => {
      setLeafIdState(id);
      navigate({
        search: { leaf: id ?? undefined },
        replace: true,
      });
    },
    [navigate],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(event: DragStartEvent) {
    const noteId = event.active.id as string;
    if (selectedNoteIds.has(noteId)) {
      setDraggedNoteIds([...selectedNoteIds]);
    } else {
      setDraggedNoteIds([noteId]);
    }
  }

  const createCategory = trpc.notes.createCategory.useMutation();
  const { data: categoriesList = [] } = trpc.notes.listCategories.useQuery({ notebookId }, { enabled: r2Initialized });

  function handleDragEnd(event: DragEndEvent) {
    const { over } = event;
    if (!over) {
      setDraggedNoteIds([]);
      return;
    }

    const dropId = over.id as string;

    if (dropId === "editor-drop-zone") {
      if (draggedNoteIds.length > 0) {
        setOpenedNoteId(draggedNoteIds[0]);
      }
    } else if (dropId === "chat-drop-zone") {
      setDroppedNoteIdsForChat([...draggedNoteIds]);
    } else if (dropId === "category-search-drop") {
      // Open category search modal
      setPendingCategoryNoteIds([...draggedNoteIds]);
    } else if (dropId.startsWith("category-")) {
      const categoryId = dropId.replace("category-", "");
      batchUpdate.mutate(
        {
          ids: draggedNoteIds,
          categoryId: categoryId === "uncategorized" ? null : categoryId,
          ...(categoryId === "uncategorized" ? { active: false } : {}),
        },
        {
          onSuccess: () => {
            utils.notes.listNotes.invalidate();
            utils.notes.listCategories.invalidate();
          },
        },
      );
    }

    setDraggedNoteIds([]);
  }

  function handleCategorySelected(categoryId: string | null) {
    if (!pendingCategoryNoteIds || pendingCategoryNoteIds.length === 0) return;
    batchUpdate.mutate(
      {
        ids: pendingCategoryNoteIds,
        categoryId,
      },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate();
          utils.notes.listCategories.invalidate();
        },
      },
    );
    setPendingCategoryNoteIds(null);
  }

  function handleCreateCategoryAndAssign(name: string) {
    if (!pendingCategoryNoteIds || pendingCategoryNoteIds.length === 0) return;
    const ids = [...pendingCategoryNoteIds];
    createCategory.mutate(
      { notebookId, name },
      {
        onSuccess: (result) => {
          batchUpdate.mutate(
            { ids, categoryId: result.id },
            {
              onSuccess: () => {
                utils.notes.listNotes.invalidate();
                utils.notes.listCategories.invalidate();
              },
            },
          );
        },
      },
    );
    setPendingCategoryNoteIds(null);
  }

  if (!r2Initialized || !notebook) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  const draggedNote = notesList?.find((n) => n.id === draggedNoteIds[0]);

  return (
    <DndContext
      sensors={sensors}
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

      {document.getElementById("header-actions") &&
        createPortal(
          <button
            type="button"
            onClick={() => setShowShareModal(true)}
            className="btn btn-ghost btn-sm btn-square"
            title="分享"
          >
            <ShareNetwork size={18} />
          </button>,
          document.getElementById("header-actions")!,
        )}

      <div className="flex flex-1 overflow-hidden">
          {/* Left: Notes Sidebar */}
          <div className="w-80 border-r border-base-300 flex flex-col overflow-hidden">
            <NotesSidebar notebookId={notebookId} draggedNoteIds={draggedNoteIds} isDragging={draggedNoteIds.length > 0} onOpenTimeMachine={() => setShowTimeMachine(true)} />
          </div>

          {/* Center: Agent Chat */}
          <div className="flex-1 flex flex-col overflow-hidden border-r border-base-300">
            <AgentChat
              notebookId={notebookId}
              notebookName={notebook.name}
              notebookDescription={notebook.description ?? ""}
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              sessionState={sessionState}
              setSessionState={setSessionState}
              leafId={leafId}
              setLeafId={setLeafId}
              onOpenModelSelector={() => setShowModelSelector(true)}
              onOpenSessionSelector={() => setShowSessionSelector(true)}
              draggedNoteIds={draggedNoteIds}
              droppedNoteIdsForChat={droppedNoteIdsForChat}
              clearDroppedNoteIds={() => setDroppedNoteIdsForChat([])}
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
      {pendingCategoryNoteIds && (
        <CategorySearchModal
          categories={categoriesList}
          onSelect={handleCategorySelected}
          onCreate={handleCreateCategoryAndAssign}
          onClose={() => setPendingCategoryNoteIds(null)}
        />
      )}
      {showMetaModal && (
        <NotebookMetaModal
          notebook={notebook}
          onClose={() => setShowMetaModal(false)}
        />
      )}
      {showModelSelector && (
        <ModelSelector
          currentConfig={modelConfig}
          onConfirm={(config) => {
            setModelConfig(config);
            setShowModelSelector(false);
          }}
          onClose={() => setShowModelSelector(false)}
        />
      )}
      {showSessionSelector && (
        <SessionSelector
          notebookId={notebookId}
          currentSessionId={sessionState.type === "session" ? sessionState.id : undefined}
          onSelect={(sid) => {
            setSessionState({ type: "session", id: sid });
            setShowSessionSelector(false);
          }}
          onClose={() => setShowSessionSelector(false)}
        />
      )}
      {showTimeMachine && (
        <TimeMachineModal
          notebookId={notebookId}
          onClose={() => setShowTimeMachine(false)}
        />
      )}
      {showShareModal && (
        <ShareModal
          notebookId={notebookId}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </DndContext>
  );
}

interface CategoryItem {
  id: string;
  name: string;
  position: number;
}

/** Modal with search input, keyboard nav, auto-focus.
 *  First option = "创建 xxx" unless exact match exists. */
function CategorySearchModal({
  categories,
  onSelect,
  onCreate,
  onClose,
}: {
  categories: CategoryItem[];
  onSelect: (categoryId: string | null) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sorted = useMemo(
    () => [...categories].sort((a, b) => a.position - b.position),
    [categories],
  );

  const query = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!query) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(query));
  }, [sorted, query]);

  const exactMatch = filtered.some((c) => c.name.toLowerCase() === query);

  // Build option list: [create?] + filtered categories + "未分类"
  const options = useMemo(() => {
    const items: { type: "create" | "category" | "uncategorized"; id: string; label: string }[] = [];
    if (query && !exactMatch) {
      items.push({ type: "create", id: "__create__", label: `创建 "${search.trim()}"` });
    }
    for (const cat of filtered) {
      items.push({ type: "category", id: cat.id, label: cat.name });
    }
    items.push({ type: "uncategorized", id: "__uncategorized__", label: "未分类" });
    return items;
  }, [query, exactMatch, filtered, search]);

  // Clamp active index when options change
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, options.length - 1)));
  }, [options.length]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function handleConfirm(index: number) {
    const opt = options[index];
    if (!opt) return;
    if (opt.type === "create") {
      onCreate(search.trim());
    } else if (opt.type === "uncategorized") {
      onSelect(null);
    } else {
      onSelect(opt.id);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-xs p-0">
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-base-300">
          <MagnifyingGlass size={14} className="text-base-content/40 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/30"
            placeholder="搜索或创建分类..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <button type="button" className="btn btn-ghost btn-xs btn-circle" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Option list */}
        <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
          {options.map((opt, i) => (
            <button
              key={opt.id}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                i === activeIndex
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-base-200 text-base-content"
              }`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => handleConfirm(i)}
            >
              {opt.type === "create" && <FolderSimplePlus size={14} />}
              <span className="truncate">{opt.label}</span>
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-base-content/40 text-center">
              无匹配分类
            </div>
          )}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
