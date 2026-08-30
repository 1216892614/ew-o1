import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useDroppable } from "@dnd-kit/core";
import { NotePencil } from "@phosphor-icons/react";
import Editor from "@monaco-editor/react";
import { trpc } from "@/client/lib/trpc";
import { openedNoteIdAtom } from "./state";

interface EditorPanelProps {
  notebookId: string;
}

export function EditorPanel({ notebookId }: EditorPanelProps) {
  const [openedNoteId, setOpenedNoteId] = useAtom(openedNoteIdAtom);
  const [theme, setTheme] = useState<"vs-dark" | "vs">("vs-dark");
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

  const openedNote = notes?.find((n) => n.id === openedNoteId) ?? null;

  const updateNote = trpc.notes.updateNote.useMutation();

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!openedNoteId || value === undefined) return;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        updateNote.mutate({ id: openedNoteId, content: value });
      }, 500);
    },
    [openedNoteId, updateNote],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Handle drop: set opened note to dropped note id
  useEffect(() => {
    // This is handled via the parent DndContext onDragEnd
    // The droppable registration here makes this a valid drop target
  }, []);

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full flex-col ${isOver ? "ring-2 ring-primary/30" : ""}`}
    >
      {/* Header */}
      <div className="flex h-10 items-center border-b border-base-300 px-3">
        {openedNote ? (
          <span className="truncate text-sm font-medium">
            {openedNote.name}
          </span>
        ) : (
          <span className="text-sm text-base-content/50">
            No file selected
          </span>
        )}
      </div>

      {/* Editor area */}
      <div className="flex-1">
        {openedNote ? (
          <Editor
            height="100%"
            language="markdown"
            theme={theme}
            value={openedNote.content ?? ""}
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
          <div className="flex h-full flex-col items-center justify-center gap-3 text-base-content/30">
            <NotePencil size={48} weight="thin" />
            <span className="text-sm">选择一个笔记开始编辑</span>
          </div>
        )}
      </div>
    </div>
  );
}
