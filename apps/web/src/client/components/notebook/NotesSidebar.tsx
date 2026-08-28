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
} from "@phosphor-icons/react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  isArchive: boolean;
  createdAt: Date;
}

interface NotesSidebarProps {
  notebookId: string;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function SortableNoteItem({
  note,
  isSelected,
  isOpened,
  onToggleSelect,
  onToggleActive,
  onOpen,
  inArchiveCategory,
}: {
  note: Note;
  isSelected: boolean;
  isOpened: boolean;
  onToggleSelect: (id: string) => void;
  onToggleActive: (note: Note) => void;
  onOpen: (id: string) => void;
  inArchiveCategory: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: note.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`px-3 py-2 flex items-center gap-2 hover:bg-base-200 rounded cursor-pointer ${
        isOpened ? "bg-base-200" : ""
      }`}
      onClick={() => onOpen(note.id)}
    >
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
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{note.name}</div>
        <div className="text-xs text-base-content/50">
          {relativeTime(note.updatedAt)} · {note.wordCount ?? 0} words
        </div>
      </div>
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

export function NotesSidebar({ notebookId }: NotesSidebarProps) {
  const [selectedIds, setSelectedIds] = useAtom(selectedNoteIdsAtom);
  const [sortMode, setSortMode] = useAtom(sortModeAtom);
  const setOpenedNoteId = useSetAtom(openedNoteIdAtom);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["__uncategorized__"]),
  );
  const [isAdding, setIsAdding] = useState(false);
  const [newNoteName, setNewNoteName] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);

  const { data: categories = [] } = trpc.notes.listCategories.useQuery({
    notebookId,
  });
  const { data: notes = [] } = trpc.notes.listNotes.useQuery({
    notebookId,
    sort: sortMode,
  });

  const createNote = trpc.notes.createNote.useMutation();
  const updateNote = trpc.notes.updateNote.useMutation();
  const batchUpdate = trpc.notes.batchUpdateNotes.useMutation();
  const utils = trpc.useUtils();

  // Expand all categories on initial load
  useEffect(() => {
    if (categories.length > 0) {
      setExpandedCategories((prev) => {
        const next = new Set(prev);
        for (const cat of categories) {
          next.add(cat.id);
        }
        return next;
      });
    }
  }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Group notes by category
  const grouped = useMemo(() => {
    const map = new Map<string, Note[]>();
    map.set("__uncategorized__", []);
    for (const cat of categories) {
      map.set(cat.id, []);
    }
    for (const note of notes) {
      const key = note.categoryId ?? "__uncategorized__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(note);
    }
    return map;
  }, [notes, categories]);

  const archiveCategory = categories.find((c) => c.isArchive);

  // Visible notes (all notes not in archive unless viewing archive)
  const visibleNotes = notes;

  const allVisibleIds = useMemo(
    () => new Set(visibleNotes.map((n) => n.id)),
    [visibleNotes],
  );

  const allSelected =
    allVisibleIds.size > 0 &&
    [...allVisibleIds].every((id) => selectedIds.has(id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
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
        {
          onSuccess: () => utils.notes.listNotes.invalidate({ notebookId }),
        },
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

  const handleBatchArchive = useCallback(() => {
    const ids = [...selectedIds];
    batchUpdate.mutate(
      { ids, archived: true },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate({ notebookId });
          setSelectedIds(new Set());
        },
      },
    );
  }, [selectedIds, batchUpdate, utils, notebookId, setSelectedIds]);

  const handleBatchUnarchive = useCallback(() => {
    const ids = [...selectedIds];
    batchUpdate.mutate(
      { ids, archived: false },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate({ notebookId });
          setSelectedIds(new Set());
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
          setSelectedIds(new Set());
        },
      },
    );
  }, [selectedIds, notes, batchUpdate, utils, notebookId, setSelectedIds]);

  const handleAddNote = useCallback(() => {
    if (!newNoteName.trim()) {
      setIsAdding(false);
      return;
    }
    createNote.mutate(
      { notebookId, name: newNoteName.trim(), categoryId: null },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate({ notebookId });
          setNewNoteName("");
          setIsAdding(false);
        },
      },
    );
  }, [newNoteName, createNote, notebookId, utils]);

  useEffect(() => {
    if (isAdding && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [isAdding]);

  const toggleCategory = (catId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const handleDragEnd = (_event: DragEndEvent) => {
    // Drop handling implemented separately
  };

  // Determine if selected notes are all in archive category
  const selectedInArchive = useMemo(() => {
    if (!archiveCategory) return false;
    const selectedNotes = notes.filter((n) => selectedIds.has(n.id));
    return (
      selectedNotes.length > 0 &&
      selectedNotes.every((n) => n.categoryId === archiveCategory.id)
    );
  }, [selectedIds, notes, archiveCategory]);

  const selectedAllActive = useMemo(() => {
    const selectedNotes = notes.filter((n) => selectedIds.has(n.id));
    return selectedNotes.length > 0 && selectedNotes.every((n) => n.active ?? true);
  }, [selectedIds, notes]);

  // Build ordered category list: uncategorized first, archive last, rest in position order
  const orderedSections = useMemo(() => {
    const sections: { id: string; name: string; isArchive: boolean }[] = [];
    const uncatNotes = grouped.get("__uncategorized__") ?? [];
    if (uncatNotes.length > 0) {
      sections.push({
        id: "__uncategorized__",
        name: "Uncategorized",
        isArchive: false,
      });
    }
    const nonArchive = categories
      .filter((c) => !c.isArchive)
      .sort((a, b) => a.position - b.position);
    for (const cat of nonArchive) {
      sections.push({ id: cat.id, name: cat.name, isArchive: false });
    }
    if (archiveCategory) {
      sections.push({
        id: archiveCategory.id,
        name: archiveCategory.name,
        isArchive: true,
      });
    }
    return sections;
  }, [categories, grouped, archiveCategory]);

  return (
    <div className="flex flex-col h-full border-r border-base-300 bg-base-100">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-base-300">
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setIsAdding(true)}
          title="Add note"
        >
          <Plus size={14} />
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={handleSelectAll}
          title={allSelected ? "Deselect all" : "Select all"}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>

        {selectedIds.size > 0 && (
          <>
            {selectedInArchive ? (
              <button
                className="btn btn-ghost btn-xs"
                onClick={handleBatchUnarchive}
                title="Unarchive"
              >
                <Tray size={14} />
              </button>
            ) : (
              <button
                className="btn btn-ghost btn-xs"
                onClick={handleBatchArchive}
                title="Archive"
              >
                <Archive size={14} />
              </button>
            )}
            <button
              className="btn btn-ghost btn-xs"
              onClick={handleBatchActiveToggle}
              title={selectedAllActive ? "Set Inactive" : "Set Active"}
            >
              <ToggleRight size={14} />
            </button>
          </>
        )}

        <div className="ml-auto">
          <div className="dropdown dropdown-end">
            <label tabIndex={0} className="btn btn-ghost btn-xs">
              <ArrowsDownUp size={14} />
            </label>
            <ul
              tabIndex={0}
              className="dropdown-content menu menu-xs bg-base-200 rounded-box shadow-lg z-10 w-28"
            >
              <li>
                <button
                  className={sortMode === "latest" ? "active" : ""}
                  onClick={() => setSortMode("latest")}
                >
                  Latest
                </button>
              </li>
              <li>
                <button
                  className={sortMode === "name" ? "active" : ""}
                  onClick={() => setSortMode("name")}
                >
                  Name
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Inline add input */}
      {isAdding && (
        <div className="px-2 py-1 border-b border-base-300">
          <input
            ref={addInputRef}
            type="text"
            className="input input-xs input-bordered w-full"
            placeholder="Note name..."
            value={newNoteName}
            onChange={(e) => setNewNoteName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddNote();
              if (e.key === "Escape") {
                setIsAdding(false);
                setNewNoteName("");
              }
            }}
            onBlur={handleAddNote}
          />
        </div>
      )}

      {/* Tree List */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 overflow-y-auto">
          {orderedSections.map((section) => {
            const sectionNotes = grouped.get(section.id) ?? [];
            const isExpanded = expandedCategories.has(section.id);

            return (
              <div key={section.id}>
                <button
                  className="flex items-center gap-1 px-3 py-1.5 w-full text-left hover:bg-base-200"
                  onClick={() => toggleCategory(section.id)}
                >
                  {isExpanded ? (
                    <CaretDown size={12} className="text-base-content/70" />
                  ) : (
                    <CaretRight size={12} className="text-base-content/70" />
                  )}
                  <span className="font-medium text-sm text-base-content/70">
                    {section.name}
                  </span>
                  <span className="text-xs text-base-content/40 ml-1">
                    ({sectionNotes.length})
                  </span>
                </button>
                {isExpanded && (
                  <SortableContext
                    items={sectionNotes.map((n) => n.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {sectionNotes.map((note) => (
                      <SortableNoteItem
                        key={note.id}
                        note={note}
                        isSelected={selectedIds.has(note.id)}
                        isOpened={false}
                        onToggleSelect={handleToggleSelect}
                        onToggleActive={handleToggleActive}
                        onOpen={handleOpen}
                        inArchiveCategory={section.isArchive}
                      />
                    ))}
                  </SortableContext>
                )}
              </div>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}
