import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Notebook } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";
import { NotebookCard } from "@/client/components/NotebookCard";
import { NotebookModal } from "@/client/components/NotebookModal";

export const Route = createFileRoute("/")({
  component: HomePage,
});

type NotebookItem = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  fileCount: number | null;
  archived: boolean | null;
  updatedAt: Date;
  createdAt: Date;
};

type ModalState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; notebook: NotebookItem };

function HomePage() {
  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [modalState, setModalState] = useState<ModalState>({ mode: "closed" });
  const isArchived = activeTab === "archived";

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    trpc.notebooks.listInfinite.useInfiniteQuery(
      { limit: 20, archived: isArchived },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
    );

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!node || !hasNextPage) return;

      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        },
        { rootMargin: "200px" },
      );
      observerRef.current.observe(node);
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  const allNotebooks = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-end gap-3 mb-6">
          <div role="tablist" className="tabs tabs-box">
            <button
              type="button"
              role="tab"
              className={`tab ${activeTab === "active" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("active")}
            >
              活跃
            </button>
            <button
              type="button"
              role="tab"
              className={`tab ${activeTab === "archived" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("archived")}
            >
              归档
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1"
            onClick={() => setModalState({ mode: "create" })}
          >
            <Plus size={16} weight="bold" />
            新建
          </button>
        </div>

        {isLoading ? (
          <NotebooksSkeletonGrid />
        ) : allNotebooks.length === 0 ? (
          <EmptyNotebooksState
            isArchived={isArchived}
            onCreate={() => setModalState({ mode: "create" })}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {allNotebooks.map((notebook) => (
                <NotebookCard
                  key={notebook.id}
                  name={notebook.name}
                  description={notebook.description ?? ""}
                  color={notebook.color ?? "#6366f1"}
                  icon={notebook.icon ?? "notebook"}
                  fileCount={notebook.fileCount ?? 0}
                  updatedAt={notebook.updatedAt}
                  onMenuClick={() => setModalState({ mode: "edit", notebook })}
                />
              ))}
            </div>

            <div ref={sentinelRef} className="h-10 mt-4">
              {isFetchingNextPage && (
                <div className="flex justify-center">
                  <span className="loading loading-dots loading-md text-primary" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {modalState.mode !== "closed" && (
        <NotebookModal
          notebook={modalState.mode === "edit" ? modalState.notebook : null}
          onClose={() => setModalState({ mode: "closed" })}
          onSaved={() => setModalState({ mode: "closed" })}
        />
      )}
    </main>
  );
}

function NotebooksSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={`skeleton-${index}`}
          className="card bg-base-200 border border-base-300"
        >
          <div className="card-body p-5 gap-3">
            <div className="flex items-start gap-3">
              <div className="skeleton w-10 h-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-5 w-3/4" />
                <div className="skeleton h-4 w-full" />
              </div>
            </div>
            <div className="flex items-center gap-4 pt-2 border-t border-base-300/50">
              <div className="skeleton h-3 w-16" />
              <div className="skeleton h-3 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyNotebooksState({ isArchived, onCreate }: { isArchived: boolean; onCreate: () => void }) {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
          <Notebook size={32} weight="duotone" className="text-primary" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-base-content">
            {isArchived ? "没有归档的笔记本" : "还没有笔记本"}
          </h2>
          <p className="text-base-content/60 max-w-sm">
            {isArchived
              ? "归档的笔记本会显示在这里"
              : "创建你的第一个笔记本，开始与 AI 一起探索知识"}
          </p>
        </div>
        {!isArchived && (
          <button type="button" className="btn btn-primary gap-2" onClick={onCreate}>
            <Plus size={18} weight="bold" />
            新建笔记本
          </button>
        )}
      </div>
    </div>
  );
}
