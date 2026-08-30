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
  UploadSimple,
  FolderSimplePlus,
  PencilSimple,
} from "@phosphor-icons/react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { trpc } from "@/client/lib/trpc";
import toast from "react-hot-toast";
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
  isDragging: boolean;
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
  activeCount,
  onToggle,
  allSelectedInCategory,
  onToggleSelectAll,
  onRename,
  children,
}: {
  sectionId: string;
  sectionName: string;
  isArchive: boolean;
  isExpanded: boolean;
  noteCount: number;
  activeCount: number;
  onToggle: () => void;
  allSelectedInCategory: boolean;
  onToggleSelectAll: () => void;
  onRename?: (newName: string) => void;
  children: React.ReactNode;
}) {
  const droppableId = isArchive ? "category-uncategorized" : `category-${sectionId}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(sectionName);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== sectionName && onRename) {
      onRename(trimmed);
    }
    setIsRenaming(false);
    setRenameValue(sectionName);
  };

  return (
    <div ref={setNodeRef}>
      <div
        className={`group flex items-center gap-1 px-3 py-1.5 w-full hover:bg-base-200 transition-colors ${
          isOver ? "bg-primary/10 ring-1 ring-primary/30" : ""
        }`}
      >
        {noteCount > 0 && (
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={allSelectedInCategory}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelectAll();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {isRenaming ? (
          <form
            className="flex items-center gap-1 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <input
              ref={renameInputRef}
              type="text"
              className="input input-xs input-bordered flex-1 min-w-0"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setIsRenaming(false);
                  setRenameValue(sectionName);
                }
              }}
              onBlur={() => submitRename()}
            />
          </form>
        ) : (
          <>
            <button
              className="flex items-center gap-1 flex-1 text-left"
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
                ({activeCount}/{noteCount})
              </span>
            </button>
            {!isArchive && onRename && (
              <button
                className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(sectionName);
                  setIsRenaming(true);
                }}
                title="重命名分类"
              >
                <PencilSimple size={12} />
              </button>
            )}
          </>
        )}
      </div>
      {children}
    </div>
  );
}


export function NotesSidebar({ notebookId, draggedNoteIds, isDragging }: NotesSidebarProps) {
  const [selectedIds, setSelectedIds] = useAtom(selectedNoteIdsAtom);
  const [sortMode, setSortMode] = useAtom(sortModeAtom);
  const setOpenedNoteId = useSetAtom(openedNoteIdAtom);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["__archived__"]),
  );
  const [addingMode, setAddingMode] = useState<"none" | "note">("none");
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
  const renameCategory = trpc.notes.renameCategory.useMutation();
  const updateNote = trpc.notes.updateNote.useMutation();
  const batchUpdate = trpc.notes.batchUpdateNotes.useMutation();
  const utils = trpc.useUtils();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleUploadFiles = useCallback(
    async (fileList: FileList) => {
      if (fileList.length === 0) return;
      setIsUploading(true);
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
        const result = (await response.json()) as { uploaded: number };
        toast.success(`已上传 ${result.uploaded} 个文件`);
        utils.notes.listNotes.invalidate();
        utils.notes.listCategories.invalidate();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "上传失败",
        );
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [notebookId, utils],
  );

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
        { onSuccess: () => utils.notes.listNotes.invalidate() },
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
          utils.notes.listNotes.invalidate();
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
          utils.notes.listNotes.invalidate();
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
    createNote.mutate(
      { notebookId, name: value, categoryId: addingInCategory },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate();
          setNewItemName("");
          setAddingMode("none");
          setAddingInCategory(null);
        },
      },
    );
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

  const handleRenameCategory = useCallback(
    (categoryId: string, newName: string) => {
      renameCategory.mutate(
        { id: categoryId, name: newName },
        {
          onSuccess: () => {
            utils.notes.listCategories.invalidate();
          },
        },
      );
    },
    [renameCategory, utils],
  );


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
        {/* Add note */}
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => {
            setAddingMode("note");
            setAddingInCategory(null);
          }}
          title="创建笔记"
        >
          <Plus size={14} />
        </button>

        {/* Upload */}
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          title="上传文件"
        >
          {isUploading ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <UploadSimple size={14} />
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept="text/*,.md,.txt,.csv,.json,.xml,.html,.htm,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.sh,.bash,.zsh,.py,.js,.ts,.jsx,.tsx,.css,.scss,.less,.sql,.r,.rs,.go,.java,.c,.cpp,.h,.hpp,.rb,.php,.swift,.kt,.scala,.lua,.pl,.tex,.bib,.org,.rst,.adoc,.nix"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleUploadFiles(e.target.files);
            }
          }}
        />

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
          <div className="text-xs text-base-content/50 mb-1">新建笔记</div>
          <input
            ref={addInputRef}
            type="text"
            className="input input-xs input-bordered w-full"
            placeholder="笔记名称..."
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
          const sectionNoteIds = sectionNotes.map((n) => n.id);
          const allInCategorySelected =
            sectionNoteIds.length > 0 &&
            sectionNoteIds.every((id) => selectedIds.has(id));

          const handleToggleCategorySelect = () => {
            setSelectedIds((prev: Set<string>) => {
              const next = new Set(prev);
              if (allInCategorySelected) {
                for (const id of sectionNoteIds) next.delete(id);
              } else {
                for (const id of sectionNoteIds) next.add(id);
              }
              return next;
            });
          };

          return (
            <DroppableCategorySection
              key={section.id}
              sectionId={section.id}
              sectionName={section.name}
              isArchive={section.isArchive}
              isExpanded={isExpanded}
              noteCount={sectionNotes.length}
              activeCount={sectionNotes.filter((n) => n.active ?? true).length}
              onToggle={() => toggleCategory(section.id)}
              allSelectedInCategory={allInCategorySelected}
              onToggleSelectAll={handleToggleCategorySelect}
              onRename={
                section.isArchive
                  ? undefined
                  : (newName: string) => handleRenameCategory(section.id, newName)
              }
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

      {/* Single drop zone at bottom — slides up when dragging */}
      <DragCategoryDropZone isDragging={isDragging} />
    </div>
  );
}

/** Single droppable zone at sidebar bottom. On drop, parent opens the search modal. */
function DragCategoryDropZone({ isDragging }: { isDragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "category-search-drop" });

  if (!isDragging) return null;

  return (
    <div
      ref={setNodeRef}
      className={`border-t border-base-300 px-3 py-3 text-center text-xs transition-colors cursor-default ${
        isOver
          ? "bg-primary/10 text-primary border-primary/30"
          : "bg-base-200/80 text-base-content/50"
      }`}
    >
      <FolderSimplePlus size={16} className="mx-auto mb-1" />
      <span>放置以修改分类</span>
    </div>
  );
}
