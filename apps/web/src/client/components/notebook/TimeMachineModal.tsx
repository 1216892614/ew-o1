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
                    diffData={detail.diffData}
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


function SnapshotDiffView({
  action,
  diffData,
}: {
  action: string;
  diffData: string | null;
}) {
  if (!diffData) {
    return (
      <div className="text-sm text-base-content/40 text-center py-8">
        无变更内容
      </div>
    );
  }

  const isUnifiedDiff = diffData.startsWith("---") || diffData.includes("@@");

  if (isUnifiedDiff) {
    return <UnifiedDiffView action={action} patch={diffData} />;
  }

  try {
    const meta = JSON.parse(diffData) as Record<
      string,
      { before: unknown; after: unknown }
    >;
    const entries = Object.entries(meta);
    if (entries.length === 0) {
      return (
        <div className="text-sm text-base-content/40 text-center py-8">
          无变更内容
        </div>
      );
    }

    const FIELD_LABELS: Record<string, string> = {
      name: "文件名",
      tag: "分类",
      categoryId: "分类",
      active: "状态",
    };

    return (
      <div>
        <div className="text-xs font-medium text-base-content/50 mb-2">
          属性变更
        </div>
        <div className="space-y-1">
          {entries.map(([key, change]) => (
            <div key={key} className="flex items-center gap-2 text-sm">
              <span className="text-base-content/50 w-16">
                {FIELD_LABELS[key] ?? key}:
              </span>
              <span className="line-through text-error/70">
                {String(change.before ?? "(无)")}
              </span>
              <span>→</span>
              <span className="text-success">
                {String(change.after ?? "(无)")}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  } catch {
    return (
      <pre className="bg-base-200 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
        {diffData}
      </pre>
    );
  }
}

function UnifiedDiffView({ action, patch }: { action: string; patch: string }) {
  const lines = patch.split("\n");

  const isBadgeAction =
    action === "create_note" || action === "delete_note" || action === "revert";
  const badgeClass =
    action === "create_note"
      ? "badge-success"
      : action === "delete_note"
        ? "badge-error"
        : "badge-warning";
  const badgeLabel =
    action === "create_note"
      ? "新建"
      : action === "delete_note"
        ? "已删除"
        : "回溯";

  return (
    <div className="space-y-3">
      {isBadgeAction && (
        <div className={`badge ${badgeClass} badge-sm gap-1`}>{badgeLabel}</div>
      )}
      <div className="text-xs font-medium text-base-content/50 mb-2">
        内容变更
      </div>
      <div className="bg-base-200 rounded-lg overflow-hidden text-xs font-mono">
        {lines.map((line, i) => {
          if (line.startsWith("---") || line.startsWith("+++")) return null;
          if (line.startsWith("@@")) {
            return (
              <div
                key={i}
                className="px-3 py-0.5 bg-info/10 text-info/70 select-none"
              >
                {line}
              </div>
            );
          }

          const isAdd = line.startsWith("+");
          const isRemove = line.startsWith("-");
          const colorClass = isAdd
            ? "bg-success/15 text-success"
            : isRemove
              ? "bg-error/15 text-error"
              : "";
          const prefix = isAdd ? "+" : isRemove ? "-" : " ";
          const text = isAdd || isRemove ? line.slice(1) : line;

          return (
            <div key={i} className={`px-3 py-0.5 ${colorClass}`}>
              <span className="inline-block w-5 text-right mr-2 text-base-content/30 select-none">
                {prefix}
              </span>
              {text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
