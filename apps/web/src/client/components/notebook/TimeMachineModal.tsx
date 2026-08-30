import { useState, useMemo, useCallback } from "react";
import {
  X,
  ClockCounterClockwise,
  ArrowCounterClockwise,
  Funnel,
  Robot,
  User,
  File,
  CalendarBlank,
} from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";
import toast from "react-hot-toast";

interface TimeMachineModalProps {
  notebookId: string;
  onClose: () => void;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN");
}

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ACTION_LABELS: Record<string, string> = {
  create_note: "创建文件",
  update_content: "修改内容",
  update_meta: "修改属性",
  delete_note: "删除文件",
  batch_update: "批量操作",
  revert: "时光机回溯",
  agent_edit_content: "AI 修改内容",
  agent_edit_file: "AI 修改属性",
};

interface SnapshotItem {
  id: string;
  noteId: string | null;
  noteName: string | null;
  action: string;
  summary: string;
  source: string;
  sessionName: string | null;
  toolName: string | null;
  revertTargetId: string | null;
  createdAt: string;
}

export function TimeMachineModal({ notebookId, onClose }: TimeMachineModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterNoteId, setFilterNoteId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const utils = trpc.useUtils();

  const { data: snapshotsData, isLoading } = trpc.timeMachine.list.useQuery({
    notebookId,
    noteId: filterNoteId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    limit: 100,
  });

  const { data: involvedFiles } = trpc.timeMachine.involvedFiles.useQuery({
    notebookId,
  });

  const { data: detail } = trpc.timeMachine.getDetail.useQuery(
    { id: selectedId! },
    { enabled: !!selectedId },
  );

  const revertMutation = trpc.timeMachine.revert.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success("已回溯到该版本");
        utils.timeMachine.list.invalidate();
        utils.notes.listNotes.invalidate();
        utils.notes.listCategories.invalidate();
      } else {
        toast.error(result.error ?? "回溯失败");
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const items: SnapshotItem[] = useMemo(
    () => (snapshotsData?.items as SnapshotItem[] | undefined) ?? [],
    [snapshotsData],
  );

  const handleRevert = useCallback(
    (snapshotId: string) => {
      revertMutation.mutate({ notebookId, snapshotId });
    },
    [notebookId, revertMutation],
  );

  const selectedItem = useMemo(
    () => items.find((s) => s.id === selectedId),
    [items, selectedId],
  );

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-4xl h-[80vh] flex flex-col p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-300">
          <div className="flex items-center gap-2">
            <ClockCounterClockwise size={20} className="text-primary" />
            <h3 className="font-bold text-lg">时光机</h3>
            <span className="text-sm text-base-content/50">
              {items.length} 条记录
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`btn btn-ghost btn-sm btn-circle ${showFilters ? "btn-active" : ""}`}
              onClick={() => setShowFilters(!showFilters)}
              title="筛选"
            >
              <Funnel size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-circle"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="flex items-center gap-3 px-4 py-2 border-b border-base-300 bg-base-200/50">
            <div className="flex items-center gap-1.5">
              <CalendarBlank size={14} className="text-base-content/50" />
              <input
                type="date"
                className="input input-xs input-bordered w-32"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                placeholder="开始日期"
              />
              <span className="text-xs text-base-content/50">至</span>
              <input
                type="date"
                className="input input-xs input-bordered w-32"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                placeholder="结束日期"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <File size={14} className="text-base-content/50" />
              <select
                className="select select-xs select-bordered"
                value={filterNoteId ?? ""}
                onChange={(e) =>
                  setFilterNoteId(e.target.value || null)
                }
              >
                <option value="">全部文件</option>
                {involvedFiles?.map((f) => (
                  <option key={f.noteId} value={f.noteId}>
                    {f.noteName}
                  </option>
                ))}
              </select>
            </div>
            {(dateFrom || dateTo || filterNoteId) && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setFilterNoteId(null);
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        )}

        {/* Body: left list + right detail */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: snapshot list */}
          <div className="w-80 border-r border-base-300 overflow-y-auto flex-shrink-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <span className="loading loading-spinner loading-sm" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-base-content/50">
                <ClockCounterClockwise size={32} className="mb-2 opacity-30" />
                <span className="text-sm">暂无操作记录</span>
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`w-full text-left px-3 py-2.5 border-b border-base-300/50 hover:bg-base-200 transition-colors cursor-pointer ${
                    selectedId === item.id ? "bg-base-200" : ""
                  }`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {item.action === "revert" ? (
                      <ArrowCounterClockwise
                        size={13}
                        className="text-warning flex-shrink-0"
                      />
                    ) : item.source === "agent" ? (
                      <Robot size={13} className="text-info flex-shrink-0" />
                    ) : (
                      <User size={13} className="text-base-content/50 flex-shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate">
                      {item.summary}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-base-content/50 ml-5">
                    <span>{formatDate(new Date(item.createdAt))}</span>
                    <span>·</span>
                    {item.source === "agent" && item.sessionName ? (
                      <span className="truncate max-w-[120px]">
                        {item.sessionName}
                        {item.toolName ? ` / ${item.toolName}` : ""}
                      </span>
                    ) : (
                      <span>{ACTION_LABELS[item.action] ?? item.action}</span>
                    )}
                  </div>
                  {item.noteName && (
                    <div className="text-xs text-base-content/40 ml-5 mt-0.5 truncate">
                      {item.noteName}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Right: detail / diff preview */}
          <div className="flex-1 overflow-y-auto">
            {!selectedId ? (
              <div className="flex flex-col items-center justify-center h-full text-base-content/40">
                <ClockCounterClockwise size={48} className="mb-3 opacity-20" />
                <span className="text-sm">选择一条记录查看详情</span>
              </div>
            ) : !detail ? (
              <div className="flex items-center justify-center h-full">
                <span className="loading loading-spinner loading-sm" />
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {/* Detail header */}
                <div className="px-4 py-3 border-b border-base-300 bg-base-200/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-sm">{detail.summary}</h4>
                      <div className="text-xs text-base-content/50 mt-0.5">
                        {formatDate(new Date(detail.createdAt))}
                        {detail.source === "agent" && detail.sessionName && (
                          <span>
                            {" · "}
                            {detail.sessionName}
                            {detail.toolName ? ` / ${detail.toolName}` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    {detail.action !== "revert" && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary gap-1"
                        onClick={() => handleRevert(detail.id)}
                        disabled={revertMutation.isPending}
                      >
                        <ArrowCounterClockwise size={14} />
                        {revertMutation.isPending ? "回溯中..." : "回溯到此版本"}
                      </button>
                    )}
                    {detail.action === "revert" && selectedItem && (
                      <button
                        type="button"
                        className="btn btn-sm btn-warning btn-outline gap-1"
                        onClick={() => {
                          if (detail.revertTargetId) {
                            handleRevert(detail.revertTargetId);
                          }
                        }}
                        disabled={revertMutation.isPending || !detail.revertTargetId}
                      >
                        <ArrowCounterClockwise size={14} />
                        {revertMutation.isPending ? "取消中..." : "取消此回溯"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Diff content */}
                <div className="flex-1 overflow-y-auto p-4">
                  <SnapshotDiffView
                    action={detail.action}
                    beforeData={detail.beforeData}
                    afterData={detail.afterData}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>
          close
        </button>
      </form>
    </dialog>
  );
}

/** Renders a diff-like view of before/after snapshot data */
function SnapshotDiffView({
  action,
  beforeData,
  afterData,
}: {
  action: string;
  beforeData: unknown;
  afterData: unknown;
}) {
  const before = beforeData as Record<string, unknown> | null;
  const after = afterData as Record<string, unknown> | null;
  const beforeNote = (before?.note ?? null) as Record<string, unknown> | null;
  const afterNote = (after?.note ?? null) as Record<string, unknown> | null;

  // Content diff
  const beforeContent = (beforeNote?.content as string) ?? "";
  const afterContent = (afterNote?.content as string) ?? "";
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");

  // Meta changes
  const metaChanges: { label: string; before: string; after: string }[] = [];
  if (beforeNote && afterNote) {
    if (beforeNote.name !== afterNote.name) {
      metaChanges.push({
        label: "文件名",
        before: (beforeNote.name as string) ?? "",
        after: (afterNote.name as string) ?? "",
      });
    }
    if (beforeNote.categoryId !== afterNote.categoryId) {
      metaChanges.push({
        label: "分类",
        before: (beforeNote.categoryId as string) ?? "(无)",
        after: (afterNote.categoryId as string) ?? "(无)",
      });
    }
    if (beforeNote.active !== afterNote.active) {
      metaChanges.push({
        label: "状态",
        before: beforeNote.active ? "启用" : "停用",
        after: afterNote.active ? "启用" : "停用",
      });
    }
  }

  const hasContentChange = beforeContent !== afterContent;
  const hasMetaChange = metaChanges.length > 0;

  if (action === "create_note") {
    return (
      <div className="space-y-3">
        <div className="badge badge-success badge-sm gap-1">新建</div>
        {afterNote && (
          <div className="text-sm">
            <div className="text-base-content/50 mb-1">文件名: {afterNote.name as string}</div>
            {afterContent && (
              <pre className="bg-success/10 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
                {afterContent}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  if (action === "delete_note") {
    return (
      <div className="space-y-3">
        <div className="badge badge-error badge-sm gap-1">已删除</div>
        {beforeNote && (
          <div className="text-sm">
            <div className="text-base-content/50 mb-1">文件名: {beforeNote.name as string}</div>
            {beforeContent && (
              <pre className="bg-error/10 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
                {beforeContent}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Meta changes */}
      {hasMetaChange && (
        <div>
          <div className="text-xs font-medium text-base-content/50 mb-2">属性变更</div>
          <div className="space-y-1">
            {metaChanges.map((change) => (
              <div
                key={change.label}
                className="flex items-center gap-2 text-sm"
              >
                <span className="text-base-content/50 w-12">{change.label}:</span>
                <span className="line-through text-error/70">{change.before}</span>
                <span>→</span>
                <span className="text-success">{change.after}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content diff */}
      {hasContentChange && (
        <div>
          <div className="text-xs font-medium text-base-content/50 mb-2">内容变更</div>
          <div className="bg-base-200 rounded-lg overflow-hidden text-xs font-mono">
            {computeSimpleDiff(beforeLines, afterLines).map((line, i) => (
              <div
                key={i}
                className={`px-3 py-0.5 ${
                  line.type === "add"
                    ? "bg-success/15 text-success"
                    : line.type === "remove"
                      ? "bg-error/15 text-error"
                      : ""
                }`}
              >
                <span className="inline-block w-5 text-right mr-2 text-base-content/30 select-none">
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                </span>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasContentChange && !hasMetaChange && (
        <div className="text-sm text-base-content/40 text-center py-8">
          无可视化差异
        </div>
      )}
    </div>
  );
}

interface DiffLine {
  type: "add" | "remove" | "same";
  text: string;
}

/** Simple line-by-line diff (no LCS, just sequential comparison). Good enough for preview. */
function computeSimpleDiff(before: string[], after: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const maxLen = Math.max(before.length, after.length);

  // Use a simple LCS-like approach for small files, fall back to sequential for large
  if (maxLen > 500) {
    // Sequential comparison for large files
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
      if (before[i] === after[j]) {
        result.push({ type: "same", text: before[i] });
        i++;
        j++;
      } else {
        result.push({ type: "remove", text: before[i] });
        i++;
        // Try to catch up
        if (j < after.length && (i >= before.length || before[i] === after[j])) {
          // don't skip
        } else {
          result.push({ type: "add", text: after[j] });
          j++;
        }
      }
    }
    while (i < before.length) {
      result.push({ type: "remove", text: before[i++] });
    }
    while (j < after.length) {
      result.push({ type: "add", text: after[j++] });
    }
    return result;
  }

  // Simple LCS for small files
  const lcs = computeLCS(before, after);
  let bi = 0;
  let ai = 0;
  for (const common of lcs) {
    while (bi < before.length && before[bi] !== common) {
      result.push({ type: "remove", text: before[bi++] });
    }
    while (ai < after.length && after[ai] !== common) {
      result.push({ type: "add", text: after[ai++] });
    }
    result.push({ type: "same", text: common });
    bi++;
    ai++;
  }
  while (bi < before.length) {
    result.push({ type: "remove", text: before[bi++] });
  }
  while (ai < after.length) {
    result.push({ type: "add", text: after[ai++] });
  }
  return result;
}

/** Compute Longest Common Subsequence (limited to ~500 lines for performance) */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}
