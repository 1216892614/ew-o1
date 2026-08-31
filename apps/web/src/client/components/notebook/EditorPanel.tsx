import { useDroppable } from "@dnd-kit/core";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  ArrowSquareOut,
  CaretDown,
  Eye,
  FolderSimple,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { trpc } from "@/client/lib/trpc";
import {
  activeNoteIdAtom,
  agentStreamingAtom,
  followModeAtom,
  lastToolFocusAtom,
  openedNoteIdsAtom,
  type ToolFocus,
} from "./state";

interface EditorPanelProps {
  notebookId: string;
}

export function EditorPanel({ notebookId }: EditorPanelProps) {
  const [openedNoteIds, setOpenedNoteIds] = useAtom(openedNoteIdsAtom);
  const [activeNoteId, setActiveNoteId] = useAtom(activeNoteIdAtom);
  const [followMode, setFollowMode] = useAtom(followModeAtom);
  const lastToolFocus = useAtomValue(lastToolFocusAtom);
  const agentStreaming = useAtomValue(agentStreamingAtom);
  const [theme, setTheme] = useState<"vs-dark" | "vs">("vs-dark");
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setNodeRef, isOver } = useDroppable({ id: "editor-drop-zone" });

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

  // Query notes list to find the opened note content
  const { data: notes } = trpc.notes.listNotes.useQuery(
    { notebookId, sort: "latest" },
    { enabled: !!notebookId },
  );

  const activeNote = notes?.find((n) => n.id === activeNoteId) ?? null;

  const updateNote = trpc.notes.updateNote.useMutation();

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeNoteId || value === undefined) return;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        updateNote.mutate({ id: activeNoteId, content: value });
      }, 500);
    },
    [activeNoteId, updateNote],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const closeTab = useCallback(
    (noteId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setOpenedNoteIds((prev) => {
        const next = prev.filter((id) => id !== noteId);
        // If closing the active tab, activate an adjacent one
        if (activeNoteId === noteId) {
          const idx = prev.indexOf(noteId);
          const newActive = next[Math.min(idx, next.length - 1)] ?? null;
          setActiveNoteId(newActive);
        }
        return next;
      });
    },
    [activeNoteId, setOpenedNoteIds, setActiveNoteId],
  );

  const handlePopOut = useCallback(() => {
    if (!activeNoteId) return;
    const url = `/notebook/${notebookId}/editor?noteId=${activeNoteId}`;
    window.open(url, `editor-${activeNoteId}`, "width=800,height=600");
  }, [activeNoteId, notebookId]);

  // Build tab data from opened IDs
  const tabs = useMemo(() => {
    if (!notes) return [];
    return openedNoteIds
      .map((id) => notes.find((n) => n.id === id))
      .filter(Boolean) as typeof notes;
  }, [openedNoteIds, notes]);

  /* ── Follow mode: render agent-driven read-only view ──── */
  if (followMode) {
    return (
      <div
        ref={setNodeRef}
        className={`flex h-full flex-col ${isOver ? "ring-2 ring-primary/30" : ""}`}
      >
        {/* Header bar with follow switch */}
        <div className="flex h-10 items-center border-b border-base-300 px-3 gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
            <input
              type="checkbox"
              className="toggle toggle-xs toggle-primary"
              checked={followMode}
              onChange={(e) => setFollowMode(e.target.checked)}
            />
            <span className="text-xs text-primary font-medium">跟随</span>
          </label>

          {agentStreaming && (
            <span className="loading loading-ring loading-xs text-primary" />
          )}

          {lastToolFocus && (
            <>
              <span className="text-base-content/20">|</span>
              <span className="text-xs text-base-content/60 truncate">
                {lastToolFocus.type === "thinking" ? (
                  <span className="italic text-base-content/50">思考中...</span>
                ) : lastToolFocus.type === "search" ? (
                  <>
                    <MagnifyingGlass size={12} className="inline mr-1" />
                    搜索: {lastToolFocus.query}
                    <span className="ml-1 badge badge-xs badge-ghost">
                      {lastToolFocus.results.length}
                    </span>
                  </>
                ) : (
                  <>
                    {"filename" in lastToolFocus &&
                      (lastToolFocus.filename ||
                        lastToolFocus.fileId.slice(0, 8))}
                    {lastToolFocus.type === "read" &&
                      lastToolFocus.lineStart != null && (
                        <span className="text-base-content/40">
                          {" "}
                          L{lastToolFocus.lineStart}
                          {lastToolFocus.lineEnd != null &&
                            `-${lastToolFocus.lineEnd}`}
                        </span>
                      )}
                    {lastToolFocus.type === "edit" && (
                      <span className="ml-1 badge badge-xs badge-outline badge-warning">
                        diff
                      </span>
                    )}
                  </>
                )}
              </span>
            </>
          )}
        </div>

        {/* Follow mode content */}
        <div className="flex-1 overflow-hidden">
          {lastToolFocus ? (
            <FollowModeContent focus={lastToolFocus} theme={theme} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-base-content/30">
              {agentStreaming ? (
                <>
                  <span className="loading loading-dots loading-lg" />
                  <span className="text-sm">AI 正在处理...</span>
                </>
              ) : (
                <>
                  <NotePencil size={48} weight="thin" />
                  <span className="text-sm">等待 AI 工具调用...</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Normal editing mode ──────────────────────────────── */
  return (
    <div
      ref={setNodeRef}
      className={`flex h-full flex-col ${isOver ? "ring-2 ring-primary/30" : ""}`}
    >
      {/* Tab bar */}
      {tabs.length > 0 ? (
        <div className="flex h-10 items-center border-b border-base-300">
          {/* Follow mode switch (left) */}
          <div className="flex items-center gap-1 px-2 shrink-0 border-r border-base-300">
            <label
              className="flex items-center gap-1 cursor-pointer"
              title="跟随模式"
            >
              <input
                type="checkbox"
                className="toggle toggle-xs toggle-primary"
                checked={followMode}
                onChange={(e) => setFollowMode(e.target.checked)}
              />
            </label>
          </div>

          <div className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-none">
            {tabs.map((note) => (
              <button
                key={note.id}
                type="button"
                className={`group flex items-center gap-1.5 px-3 h-10 text-sm border-r border-base-300 shrink-0 max-w-[180px] transition-colors ${
                  activeNoteId === note.id
                    ? "bg-base-100 font-medium"
                    : "bg-base-200/50 text-base-content/60 hover:bg-base-200"
                }`}
                onClick={() => setActiveNoteId(note.id)}
              >
                <span className="truncate text-xs">{note.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="opacity-0 group-hover:opacity-100 hover:text-error transition-opacity ml-auto"
                  onClick={(e) => closeTab(note.id, e)}
                  onKeyDown={(e) => e.key === "Enter" && closeTab(note.id)}
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-1 px-2 shrink-0 border-l border-base-300">
            {activeNote && (
              <CategoryCombobox
                notebookId={notebookId}
                noteId={activeNote.id}
                currentCategoryId={activeNote.categoryId}
              />
            )}
            {/* Edit / Preview toggle */}
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
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-square tooltip tooltip-bottom"
              data-tip="在新窗口打开"
              onClick={handlePopOut}
            >
              <ArrowSquareOut size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex h-10 items-center border-b border-base-300 px-3 gap-2">
          {/* Follow mode switch even when no tabs */}
          <label
            className="flex items-center gap-1 cursor-pointer"
            title="跟随模式"
          >
            <input
              type="checkbox"
              className="toggle toggle-xs toggle-primary"
              checked={followMode}
              onChange={(e) => setFollowMode(e.target.checked)}
            />
          </label>
          <span className="text-sm text-base-content/50">
            选择一个笔记开始编辑
          </span>
        </div>
      )}

      {/* Editor / Preview area */}
      <div className="flex-1 overflow-hidden">
        {activeNote ? (
          viewMode === "edit" ? (
            <Editor
              key={activeNote.id}
              height="100%"
              language="markdown"
              theme={theme}
              value={activeNote.content ?? ""}
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
                  {activeNote.content ?? ""}
                </Streamdown>
              </div>
            </div>
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-base-content/30">
            <NotePencil size={48} weight="thin" />
            <span className="text-sm">选择一个笔记开始编辑</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Follow mode content: read-only editor following tool calls ── */

function FollowModeContent({
  focus,
  theme,
}: {
  focus: ToolFocus;
  theme: "vs-dark" | "vs";
}) {
  type MonacoEditor = Parameters<OnMount>[0];
  const editorRef = useRef<MonacoEditor | null>(null);

  if (focus.type === "read") {
    // Strip line number prefixes (e.g. "1: # Title\n2: content")
    const rawContent = focus.content;
    const lines = rawContent.split("\n");
    const stripped = lines.map((line) => {
      const m = line.match(/^\d+:\s?(.*)$/);
      return m ? m[1] : line;
    });
    const displayContent = stripped.join("\n");

    return (
      <Editor
        key={`follow-read-${focus.fileId}-${focus.lineStart ?? 0}`}
        height="100%"
        language="markdown"
        theme={theme}
        value={displayContent}
        onMount={(editor) => {
          editorRef.current = editor;

          // Highlight the read range if specified
          if (focus.lineStart != null) {
            // Map focus lines to editor lines (content may be a slice)
            const startLine = 1;
            const endLine = stripped.length;

            const _decorations = editor.createDecorationsCollection([
              {
                range: {
                  startLineNumber: startLine,
                  startColumn: 1,
                  endLineNumber: endLine,
                  endColumn: 1,
                },
                options: {
                  isWholeLine: true,
                  className: "follow-highlight-line",
                  overviewRuler: {
                    color: "#6366f1",
                    position: 1, // OverviewRulerLane.Center
                  },
                },
              },
            ]);

            // Scroll to the highlighted range
            editor.revealLineInCenter(startLine);
          }
        }}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          lineNumbers: (lineNumber: number) => {
            // Show original line numbers when we know the start
            if (focus.lineStart != null) {
              return String(focus.lineStart + lineNumber - 1);
            }
            return String(lineNumber);
          },
          wordWrap: "on",
          fontSize: 14,
          padding: { top: 16 },
          renderValidationDecorations: "off" as const,
          scrollBeyondLastLine: false,
          domReadOnly: true,
        }}
      />
    );
  }

  if (focus.type === "search") {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-2 text-sm text-base-content/60">
          <MagnifyingGlass size={16} />
          <span>
            搜索:{" "}
            <strong className="text-base-content/80">{focus.query}</strong>
          </span>
          <span className="badge badge-sm badge-ghost">
            {focus.results.length} 条结果
          </span>
        </div>
        {focus.results.length === 0 ? (
          <div className="text-center text-base-content/30 py-8">
            <span className="text-sm">无匹配结果</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {focus.results.map((item, i) => (
              <div
                key={`${item.fileId}-${i}`}
                className="flex items-start gap-2 rounded-lg border border-base-300 bg-base-200/30 p-2.5 text-sm"
              >
                <FolderSimple
                  size={16}
                  className="text-base-content/40 shrink-0 mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-base-content/80 truncate">
                    {item.filename || item.fileId.slice(0, 12)}
                  </div>
                  {item.summary && (
                    <div className="text-xs text-base-content/50 mt-0.5 line-clamp-2">
                      {item.summary}
                    </div>
                  )}
                </div>
                {item.relevance != null && (
                  <span className="badge badge-xs badge-ghost shrink-0">
                    {Math.round(item.relevance * 100)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (focus.type === "thinking") {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-2 text-sm text-base-content/60">
          {!focus.done && (
            <span className="loading loading-spinner loading-xs" />
          )}
          <span className="italic">思考过程</span>
        </div>
        <div className="prose prose-sm max-w-none text-base-content/60 [&_pre]:bg-base-200 [&_pre]:text-base-content/80 [&_code]:text-base-content/80 whitespace-pre-wrap font-mono text-xs leading-relaxed">
          {focus.content || "..."}
        </div>
      </div>
    );
  }

  // edit type: show diff
  const { diff } = focus;

  // Parse unified diff to extract original and modified content
  const { original, modified } = parseDiffForDisplay(diff);

  return (
    <DiffEditor
      key={`follow-edit-${focus.fileId}`}
      height="100%"
      language="markdown"
      theme={theme}
      original={original}
      modified={modified}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 14,
        padding: { top: 16 },
        renderSideBySide: false,
        scrollBeyondLastLine: false,
        domReadOnly: true,
        originalEditable: false,
      }}
    />
  );
}

/** Parse a unified diff hunk into original/modified text for DiffEditor */
function parseDiffForDisplay(diff: string): {
  original: string;
  modified: string;
} {
  const lines = diff.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
    } else if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      // context line
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    } else {
      // bare line (no prefix) — treat as context
      originalLines.push(line);
      modifiedLines.push(line);
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
  };
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

  const { data: categories = [] } = trpc.notes.listCategories.useQuery({
    notebookId,
  });
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

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
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
            {/* Uncategorized option */}
            <button
              type="button"
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-base-300 transition-colors ${
                currentCategoryId === null
                  ? "text-primary font-medium"
                  : "text-base-content/70"
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
            {/* Create new option */}
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
