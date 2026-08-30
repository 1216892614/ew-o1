import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { FolderSimple, CaretDown, Plus, PencilSimple, Eye } from "@phosphor-icons/react";
import Editor from "@monaco-editor/react";
import { Streamdown } from "streamdown";
import { trpc } from "@/client/lib/trpc";
import { z } from "zod";

const editorSearchSchema = z.object({
  noteId: z.string(),
});

export const Route = createFileRoute("/notebook/$id_/editor")({
  component: PopupEditorPage,
  validateSearch: editorSearchSchema,
});

function PopupEditorPage() {
  const { id: notebookId } = Route.useParams();
  const { noteId } = Route.useSearch();
  const [theme, setTheme] = useState<"vs-dark" | "vs">("vs-dark");
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Theme detection
  useEffect(() => {
    function detectTheme() {
      const html = document.documentElement;
      const dataTheme = html.getAttribute("data-theme");
      if (dataTheme === "dark" || html.classList.contains("dark")) {
        setTheme("vs-dark");
      } else {
        setTheme("vs");
      }
    }
    detectTheme();
    const observer = new MutationObserver(detectTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

  const { data: notes } = trpc.notes.listNotes.useQuery(
    { notebookId, sort: "latest" },
    { enabled: !!notebookId },
  );

  const note = notes?.find((n) => n.id === noteId) ?? null;
  const updateNote = trpc.notes.updateNote.useMutation();

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!noteId || value === undefined) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateNote.mutate({ id: noteId, content: value });
      }, 500);
    },
    [noteId, updateNote],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Set window title
  useEffect(() => {
    if (note) {
      document.title = `${note.name} — Editor`;
    }
  }, [note?.name]);

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with name, category, and edit/preview toggle */}
      <div className="flex h-10 items-center border-b border-base-300 px-3 gap-2">
        <span className="truncate text-sm font-medium flex-1 min-w-0">
          {note.name}
        </span>
        <CategoryCombobox
          notebookId={notebookId}
          noteId={note.id}
          currentCategoryId={note.categoryId}
        />
        <div className="join">
          <button
            type="button"
            className={`btn btn-ghost btn-xs join-item tooltip tooltip-bottom ${viewMode === "edit" ? "btn-active" : ""}`}
            data-tip="编辑"
            onClick={() => setViewMode("edit")}
          >
            <PencilSimple size={14} />
          </button>
          <button
            type="button"
            className={`btn btn-ghost btn-xs join-item tooltip tooltip-bottom ${viewMode === "preview" ? "btn-active" : ""}`}
            data-tip="预览"
            onClick={() => setViewMode("preview")}
          >
            <Eye size={14} />
          </button>
        </div>
      </div>

      {/* Editor / Preview */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "edit" ? (
          <Editor
            height="100%"
            language="markdown"
            theme={theme}
            value={note.content ?? ""}
            onChange={handleChange}
            options={{
              minimap: { enabled: false },
              lineNumbers: "on",
              wordWrap: "on",
              fontSize: 14,
              padding: { top: 16 },
            }}
          />
        ) : (
          <div className="h-full overflow-y-auto p-6">
            <div className="prose prose-sm max-w-none text-base-content [&_pre]:bg-base-200 [&_pre]:text-base-content/80 [&_code]:text-base-content/80">
              <Streamdown mode="static">
                {note.content ?? ""}
              </Streamdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact combobox: pick existing category or type a new one */
function CategoryCombobox({
  notebookId,
  noteId,
  currentCategoryId,
}: {
  notebookId: string;
  noteId: string;
  currentCategoryId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: categories = [] } = trpc.notes.listCategories.useQuery({ notebookId });
  const updateNote = trpc.notes.updateNote.useMutation();
  const createCategory = trpc.notes.createCategory.useMutation();
  const utils = trpc.useUtils();

  const currentCategory = categories.find((c) => c.id === currentCategoryId);

  const filtered = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, search]);

  const exactMatch = categories.some(
    (c) => c.name.toLowerCase() === search.trim().toLowerCase(),
  );

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function assignCategory(categoryId: string | null) {
    updateNote.mutate(
      { id: noteId, categoryId },
      {
        onSuccess: () => {
          utils.notes.listNotes.invalidate();
          utils.notes.listCategories.invalidate();
        },
      },
    );
    setOpen(false);
    setSearch("");
  }

  function handleCreateAndAssign() {
    const name = search.trim();
    if (!name) return;
    createCategory.mutate(
      { notebookId, name },
      {
        onSuccess: (result) => {
          assignCategory(result.id);
        },
      },
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="btn btn-ghost btn-xs gap-1 text-base-content/60 hover:text-base-content"
        onClick={() => {
          setOpen(!open);
          if (!open) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
      >
        <FolderSimple size={12} />
        <span className="text-xs max-w-[100px] truncate">
          {currentCategory?.name ?? "未分类"}
        </span>
        <CaretDown size={10} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-base-200 rounded-lg shadow-lg border border-base-300 overflow-hidden">
          <div className="p-1.5">
            <input
              ref={inputRef}
              type="text"
              className="input input-xs input-bordered w-full"
              placeholder="搜索或新建分类..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  setSearch("");
                } else if (e.key === "Enter" && search.trim() && !exactMatch) {
                  handleCreateAndAssign();
                }
              }}
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            <button
              type="button"
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-base-300 transition-colors ${
                currentCategoryId === null ? "text-primary font-medium" : "text-base-content/70"
              }`}
              onClick={() => assignCategory(null)}
            >
              未分类
            </button>
            {filtered.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-base-300 transition-colors ${
                  currentCategoryId === cat.id ? "text-primary font-medium" : ""
                }`}
                onClick={() => assignCategory(cat.id)}
              >
                {cat.name}
              </button>
            ))}
            {search.trim() && !exactMatch && (
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-base-300 transition-colors flex items-center gap-1"
                onClick={handleCreateAndAssign}
              >
                <Plus size={10} />
                <span>创建 "{search.trim()}"</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
