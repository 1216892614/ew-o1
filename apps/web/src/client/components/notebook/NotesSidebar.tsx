import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  Plus,
  CheckSquare,
  Square,
  Archive,
  ToggleRight,
  CaretDown,
  CaretRight,
  ArrowsDownUp,
  Tray,
  FolderPlus,
  NotePencil,
} from "@phosphor-icons/react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { trpc } from "@/client/lib/trpc";
import { selectedNoteIdsAtom, sortModeAtom, openedNoteIdAtom } from "./state";

interface Note {
  id: string;
  notebookId: string;
  categoryId: string | null;
  name: string;
  content: string | null;
  wordCount: number | null;
  active: boolean | null;
  archived: boolean | null;
  position: number;
  updatedAt: Date;
  createdAt: Date;
}

interface Category {
  id: string;
  notebookId: string;
  name: string;
  position: number;
  isArchive: boolean | null;
  createdAt: Date;
}

interface NotesSidebarProps {
  notebookId: string;
  draggedNoteIds: string[];
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}天前`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}个月前`;
  return `${Math.floor(diffMonths / 12)}年前`;
}

function DraggableNoteItem({
  note,
  isSelected,
  isOpened,
  isBeingDragged,
  onToggleSelect,
  onToggleActive,
  onOpen,
  inArchiveCategory,
}: {
  note: Note;
  isSelected: boolean;
  isOpened: boolean;
  isBeingDragged: boolean;
  onToggleSelect: (id: string) => void;
  onToggleActive: (note: Note) => void;
  onOpen: (id: string) => void;
  inArchiveCategory: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } =
    useDraggable({ id: note.id });

  const dimmed = isDragging || isBeingDragged;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: dimmed ? 0.3 : 1 }}
      className={`flex items-center gap-2 px-3 py-2 hover:bg-base-200 rounded cursor-pointer mx-1 ${
        isOpened ? "bg-base-200" : ""
      }`}
      onClick={() => onOpen(note.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(note.id)}
      role="button"
      tabIndex={0}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        className="checkbox checkbox-xs"
        checked={isSelected}
        onChange={(e) => {
          e.stopPropagation();
          onToggleSelect(note.id);
        }}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Name + metadata */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{note.name}</div>
        <div className="text-xs text-base-content/50 flex gap-2">
          <span>{relativeTime(note.updatedAt)}</span>
          <span>{note.wordCount ?? 0}字</span>
        </div>
      </div>

      {/* Active toggle */}
      <input
        type="checkbox"
        className="toggle toggle-xs toggle-primary"
        checked={note.active ?? true}
        onChange={(e) => {
          e.stopPropagation();
          onToggleActive(note);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
function DroppableCategorySection({
  sectionId,
  sectionName,
  isArchive,
  isExpanded,
  noteCount,
  onToggle,
  children,
}: {
  sectionId: string;
  sectionName: string;
  isArchive: boolean;
  isExpanded: boolean;
  noteCount: number;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const droppableId = isArchive ? "category-uncategorized" : `category-${sectionId}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div ref={setNodeRef}>
      <button
        className={`flex items-center gap-1 px-3 py-1.5 w-full text-left hover:bg-base-200 transition-colors ${
          isOver ? "bg-primary/10 ring-1 ring-primary/30" : ""
        }`}
        onClick={onToggle}
      >
        {isExpanded ? (
          <CaretDown size={12} className="text-base-content/70" />
        ) : (
          <CaretRight size={12} className="text-base-content/70" />
        )}
        <span className="font-medium text-sm text-base-content/70">
          {sectionName}
        </span>
        <span className="text-xs text-base-content/40 ml-1">
          ({noteCount})
        </span>
      </button>
      {children}
    </div>
  );
}


export function NotesSidebar({ notebookId, draggedNoteIds }: NotesSidebarProps) {
  const [selectedIds, setSelectedIds] = useAtom(selectedNoteIdsAtom);
  const [sortMode, setSortMode] = useAtom(sortModeAtom);
  const setOpenedNoteId = useSetAtom(openedNoteIdAtom);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["__archived__"]),
  );
  const [addingMode, setAddingMode] = useState<"none" | "note" | "category">("none");
  const [newItemName, setNewItemName] = useState("");
  const [addingInCategory, setAddingInCategory] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const { data: categories = [] } = trpc.notes.listCategories.useQuery({
    notebookId,
  });
  const { data: notes = [] } = trpc.notes.listNotes.useQuery({
    notebookId,
    sort: sortMode,
  });

  const createNote = trpc.notes.createNote.useMutation();
  const createCategory = trpc.notes.createCategory.useMutation();
  const updateNote = trpc.notes.updateNote.useMutation();
  const batchUpdate = trpc.notes.batchUpdateNotes.useMutation();
  const utils = trpc.useUtils();

  // Expand all categories on initial load
  useEffect(() => {
    if (categories.length > 0) {
      setExpandedCategories((prev) => {
        const next = new Set(prev);
        next.add("__archived__");
        for (const cat of categories) {
          next.add(cat.id);
        }
        return next;
      });
    }
  }, [categories]);


  // Group notes: notes with categoryId → that category, notes without categoryId → archive
  const grouped = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const cat of categories) {
      map.set(cat.id, []);
    }
    map.set("__archived__", []);
    for (const note of notes) {
      const key = note.categoryId ?? "__archived__";
      if (!map.has(key)) {
        // categoryId references a deleted category, move to archive
        map.get("__archived__")!.push(note);
      } else {
        map.get(key)!.push(note);
      }
    }
    return map;
  }, [notes, categories]);

  // All visible note IDs
  const allVisibleIds = useMemo(
    () => new Set(notes.map((n) => n.id)),
    [notes],
  );

  const allSelected =
    allVisibleIds.size > 0 &&
    [...allVisibleIds].every((id) => selectedIds.has(id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set<string>());
    } else {
      setSelectedIds(new Set(allVisibleIds));
    }
  }, [allSelected, allVisibleIds, setSelectedIds]);

  const handleToggleSelect = useCallback(
    (id: string) => {
      setSelectedIds((prev: Set<string>) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setSelectedIds],
  );

  const handleToggleActive = useCallback(
    (note: Note) => {
      updateNote.mutate(
        { id: note.id, active: !(note.active ?? true) },
        { onSuccess: () => utils.notes.listNotes.invalidate({ notebookId }) },
      );
    },
    [updateNote, utils, notebookId],
  );

  const handleOpen = useCallback(
    (id: string) => {
      setOpenedNoteId(id);
    },
    [setOpenedNoteId],
  );

  // Batch archive = move to no category (which IS the archive)
  const handleBatchArchive = useCallback(() => {
    const ids = [...selectedIds];
    batchUpdate.mutate(
      { ids, categoryId: null },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate({ notebookId });
          setSelectedIds(new Set<string>());
        },
      },
    );
  }, [selectedIds, batchUpdate, utils, notebookId, setSelectedIds]);

  const handleBatchActiveToggle = useCallback(() => {
    const selectedNotes = notes.filter((n) => selectedIds.has(n.id));
    const allActive = selectedNotes.every((n) => n.active ?? true);
    const ids = [...selectedIds];
    batchUpdate.mutate(
      { ids, active: !allActive },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate({ notebookId });
          setSelectedIds(new Set<string>());
        },
      },
    );
  }, [selectedIds, notes, batchUpdate, utils, notebookId, setSelectedIds]);

  // Create note (default goes to archive = null categoryId)
  function handleSubmit() {
    const value = addInputRef.current?.value.trim() ?? "";
    if (!value) {
      setAddingMode("none");
      setNewItemName("");
      return;
    }
    if (addingMode === "category") {
      createCategory.mutate(
        { notebookId, name: value },
        {
          onSuccess: () => {
            utils.notes.listCategories.invalidate({ notebookId });
            setNewItemName("");
            setAddingMode("none");
          },
        },
      );
    } else {
      createNote.mutate(
        { notebookId, name: value, categoryId: addingInCategory },
        {
          onSuccess: () => {
            utils.notes.listNotes.invalidate({ notebookId });
            setNewItemName("");
            setAddingMode("none");
            setAddingInCategory(null);
          },
        },
      );
    }
  }

  useEffect(() => {
    if (addingMode !== "none" && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [addingMode]);

  const toggleCategory = (catId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };


  // Check if selected notes are all in archive (categoryId === null)
  const selectedInArchive = useMemo(() => {
    const selectedNotes = notes.filter((n) => selectedIds.has(n.id));
    return (
      selectedNotes.length > 0 &&
      selectedNotes.every((n) => n.categoryId === null)
    );
  }, [selectedIds, notes]);

  const selectedAllActive = useMemo(() => {
    const selectedNotes = notes.filter((n) => selectedIds.has(n.id));
    return selectedNotes.length > 0 && selectedNotes.every((n) => n.active ?? true);
  }, [selectedIds, notes]);

  const draggedSet = useMemo(() => new Set(draggedNoteIds), [draggedNoteIds]);

  // Build ordered sections: real categories first (by position), then archive at bottom
  const orderedSections = useMemo(() => {
    const sections: { id: string; name: string; isArchive: boolean }[] = [];
    const sorted = [...categories].sort((a, b) => a.position - b.position);
    for (const cat of sorted) {
      sections.push({ id: cat.id, name: cat.name, isArchive: false });
    }
    // Archive is always last — notes with no categoryId
    sections.push({ id: "__archived__", name: "已归档", isArchive: true });
    return sections;
  }, [categories]);

  return (
    <div className="flex flex-col h-full bg-base-100">
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b border-base-300">
        {/* Add dropdown */}
        <div className="dropdown">
          <label tabIndex={0} className="btn btn-ghost btn-xs" title="创建">
            <Plus size={14} />
          </label>
          <ul
            tabIndex={0}
            className="dropdown-content menu menu-xs bg-base-200 rounded-box shadow-lg z-10 w-28"
          >
            <li>
              <button
                onClick={() => {
                  setAddingMode("category");
                  setAddingInCategory(null);
                }}
              >
                <FolderPlus size={14} />
                创建分类
              </button>
            </li>
            <li>
              <button
                onClick={() => {
                  setAddingMode("note");
                  setAddingInCategory(null);
                }}
              >
                <NotePencil size={14} />
                创建笔记
              </button>
            </li>
          </ul>
        </div>

        {/* Select all */}
        <button
          className="btn btn-ghost btn-xs"
          onClick={handleSelectAll}
          title={allSelected ? "全反选" : "全选"}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>

        {/* Batch actions when selected */}
        {selectedIds.size > 0 && (
          <>
            {!selectedInArchive && (
              <button
                className="btn btn-ghost btn-xs"
                onClick={handleBatchArchive}
                title="批量归档"
              >
                <Archive size={14} />
              </button>
            )}
            <button
              className="btn btn-ghost btn-xs"
              onClick={handleBatchActiveToggle}
              title={selectedAllActive ? "批量停用" : "批量启用"}
            >
              <ToggleRight size={14} />
            </button>
          </>
        )}

        {/* Sort */}
        <div className="ml-auto">
          <div className="dropdown dropdown-end">
            <label tabIndex={0} className="btn btn-ghost btn-xs">
              <ArrowsDownUp size={14} />
            </label>
            <ul
              tabIndex={0}
              className="dropdown-content menu menu-xs bg-base-200 rounded-box shadow-lg z-10 w-24"
            >
              <li>
                <button
                  className={sortMode === "latest" ? "active" : ""}
                  onClick={() => setSortMode("latest")}
                >
                  最新
                </button>
              </li>
              <li>
                <button
                  className={sortMode === "name" ? "active" : ""}
                  onClick={() => setSortMode("name")}
                >
                  名称
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Inline add input */}
      {addingMode !== "none" && (
        <form
          className="px-2 py-1.5 border-b border-base-300"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="text-xs text-base-content/50 mb-1">
            {addingMode === "category" ? "新建分类" : "新建笔记"}
          </div>
          <input
            ref={addInputRef}
            type="text"
            className="input input-xs input-bordered w-full"
            placeholder={addingMode === "category" ? "分类名称..." : "笔记名称..."}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setAddingMode("none");
                setNewItemName("");
              }
            }}
            onBlur={() => handleSubmit()}
          />
        </form>
      )}

      {/* Tree List */}
        <div className="flex-1 overflow-y-auto">
          {orderedSections.map((section) => {
            const sectionNotes = grouped.get(section.id) ?? [];
            const isExpanded = expandedCategories.has(section.id);

            return (
              <DroppableCategorySection
                key={section.id}
                sectionId={section.id}
                sectionName={section.name}
                isArchive={section.isArchive}
                isExpanded={isExpanded}
                noteCount={sectionNotes.length}
                onToggle={() => toggleCategory(section.id)}
              >
                {isExpanded &&
                  sectionNotes.map((note) => (
                    <DraggableNoteItem
                      key={note.id}
                      note={note}
                      isSelected={selectedIds.has(note.id)}
                      isOpened={false}
                      isBeingDragged={draggedSet.has(note.id)}
                      onToggleSelect={handleToggleSelect}
                      onToggleActive={handleToggleActive}
                      onOpen={handleOpen}
                      inArchiveCategory={section.isArchive}
                    />
                  ))}
              </DroppableCategorySection>
            );
          })}
        </div>
    </div>
  );
}
