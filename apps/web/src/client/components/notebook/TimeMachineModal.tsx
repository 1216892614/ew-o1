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
  CaretDown,
  CaretRight,
  Stack,
} from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";
import toast from "react-hot-toast";

interface TimeMachineModalProps {
  notebookId: string;
  onClose: () => void;
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
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
  agent_create: "AI 创建文件",
  agent_edit_meta: "AI 修改属性",
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
  groupId: string | null;
  createdAt: string;
}

interface SnapshotDetail {
  id: string;
  notebookId: string;
  noteId: string | null;
  noteName: string | null;
  action: string;
  summary: string;
  source: string;
  sessionName: string | null;
  toolName: string | null;
  diffData: string | null;
  revertTargetId: string | null;
  createdAt: string;
}

interface SnapshotGroup {
  /** groupId or a synthetic id for ungrouped items */
  id: string;
  items: SnapshotItem[];
  /** Representative timestamp (earliest in group) */
  createdAt: string;
  /** Whether this is a multi-item group */
  isGroup: boolean;
}

function buildGroups(items: SnapshotItem[]): SnapshotGroup[] {
  const groupMap = new Map<string, SnapshotItem[]>();
  const order: string[] = [];
  let syntheticIdx = 0;

  for (const item of items) {
    const key = item.groupId ?? `__single_${syntheticIdx++}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groupMap.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const groupItems = groupMap.get(key)!;
    return {
      id: key,
      items: groupItems,
      createdAt: groupItems[groupItems.length - 1].createdAt,
      isGroup: groupItems.length > 1,
    };
  });
}

function groupSummary(group: SnapshotGroup): string {
  if (!group.isGroup) return group.items[0].summary;
  const fileNames = new Set(group.items.map((i) => i.noteName).filter(Boolean));
  const isAgent = group.items.some((i) => i.source === "agent");
  if (isAgent) {
    return `AI 修改了 ${fileNames.size || group.items.length} 个文件`;
  }
  return `批量操作 ${group.items.length} 条记录`;
}

function groupSource(group: SnapshotGroup): string {
  return group.items[0].source;
}

function groupIcon(group: SnapshotGroup) {
  if (group.items.some((i) => i.action === "revert")) {
    return <ArrowCounterClockwise size={13} className="text-warning flex-shrink-0" />;
  }
  if (group.items.some((i) => i.source === "agent")) {
    return <Robot size={13} className="text-info flex-shrink-0" />;
  }
  return <User size={13} className="text-base-content/50 flex-shrink-0" />;
}

export function TimeMachineModal({ notebookId, onClose }: TimeMachineModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Track whether a group or individual snapshot is selected */
  const [selectedType, setSelectedType] = useState<"group" | "item">("item");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
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

  const items: SnapshotItem[] = useMemo(
    () => (snapshotsData?.items as SnapshotItem[] | undefined) ?? [],
    [snapshotsData],
  );

  const groups = useMemo(() => buildGroups(items), [items]);

  const totalCount = items.length;

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const selectGroup = useCallback((groupId: string) => {
    setSelectedId(groupId);
    setSelectedType("group");
  }, []);

  const selectItem = useCallback((itemId: string) => {
    setSelectedId(itemId);
    setSelectedType("item");
  }, []);

  /** Find the selected group or the group containing the selected item */
  const selectedGroup = useMemo(() => {
    if (!selectedId) return null;
    if (selectedType === "group") {
      return groups.find((g) => g.id === selectedId) ?? null;
    }
    return groups.find((g) => g.items.some((i) => i.id === selectedId)) ?? null;
  }, [groups, selectedId, selectedType]);

  const selectedItem = useMemo(() => {
    if (!selectedId || selectedType !== "item") return null;
    return items.find((i) => i.id === selectedId) ?? null;
  }, [items, selectedId, selectedType]);

  const { data: detail } = trpc.timeMachine.getDetail.useQuery(
    { id: selectedType === "item" && selectedId ? selectedId : "" },
    { enabled: selectedType === "item" && !!selectedId },
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

  const handleRevert = useCallback(
    (snapshotId: string) => {
      revertMutation.mutate({ notebookId, snapshotId });
    },
    [notebookId, revertMutation],
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
              {totalCount} 条记录
              {groups.length !== totalCount && ` · ${groups.length} 组`}
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
          {/* Left: group list */}
          <div className="w-80 border-r border-base-300 overflow-y-auto flex-shrink-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <span className="loading loading-spinner loading-sm" />
              </div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-base-content/50">
                <ClockCounterClockwise size={32} className="mb-2 opacity-30" />
                <span className="text-sm">暂无操作记录</span>
              </div>
            ) : (
              groups.map((group) => (
                <GroupEntry
                  key={group.id}
                  group={group}
                  selectedId={selectedId}
                  selectedType={selectedType}
                  isExpanded={expandedGroups.has(group.id)}
                  onToggle={toggleGroup}
                  onSelectGroup={selectGroup}
                  onSelectItem={selectItem}
                />
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
            ) : selectedType === "item" && detail ? (
              <SingleDetail
                detail={detail}
                selectedItem={selectedItem}
                onRevert={handleRevert}
                isPending={revertMutation.isPending}
              />
            ) : selectedType === "group" && selectedGroup ? (
              <GroupDetail
                group={selectedGroup}
                onRevert={handleRevert}
                onSelectItem={selectItem}
                isPending={revertMutation.isPending}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <span className="loading loading-spinner loading-sm" />
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

/* ── Group entry in left panel ──────────────────────────── */

function GroupEntry({
  group,
  selectedId,
  selectedType,
  isExpanded,
  onToggle,
  onSelectGroup,
  onSelectItem,
}: {
  group: SnapshotGroup;
  selectedId: string | null;
  selectedType: "group" | "item";
  isExpanded: boolean;
  onToggle: (id: string) => void;
  onSelectGroup: (id: string) => void;
  onSelectItem: (id: string) => void;
}) {
  if (!group.isGroup) {
    // Single item — render inline like before
    const item = group.items[0];
    const isSelected = selectedType === "item" && selectedId === item.id;
    return (
      <button
        type="button"
        className={`w-full text-left px-3 py-2.5 border-b border-base-300/50 hover:bg-base-200 transition-colors cursor-pointer ${
          isSelected ? "bg-base-200" : ""
        }`}
        onClick={() => onSelectItem(item.id)}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          {itemIcon(item)}
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
    );
  }

  // Multi-item group
  const isGroupSelected = selectedType === "group" && selectedId === group.id;

  return (
    <div className="border-b border-base-300/50">
      {/* Group header */}
      <button
        type="button"
        className={`w-full text-left px-3 py-2.5 hover:bg-base-200 transition-colors cursor-pointer ${
          isGroupSelected ? "bg-primary/10" : ""
        }`}
        onClick={() => onSelectGroup(group.id)}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          {groupIcon(group)}
          <Stack size={13} className="text-base-content/40 flex-shrink-0" />
          <span className="text-sm font-medium truncate">
            {groupSummary(group)}
          </span>
          <span className="badge badge-xs badge-ghost ml-auto flex-shrink-0">
            {group.items.length}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-base-content/50 ml-5">
          <span>{formatDate(new Date(group.createdAt))}</span>
          <span>·</span>
          <span>
            {[...new Set(group.items.map((i) => i.noteName).filter(Boolean))].join("、") || "多个文件"}
          </span>
        </div>
      </button>

      {/* Expand toggle */}
      <button
        type="button"
        className="w-full flex items-center gap-1 px-3 py-1 text-xs text-base-content/40 hover:text-base-content/60 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onToggle(group.id);
        }}
      >
        {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span>{isExpanded ? "收起" : "展开"}详情</span>
      </button>

      {/* Expanded children */}
      {isExpanded && (
        <div className="bg-base-200/30">
          {group.items.map((item) => {
            const isItemSelected = selectedType === "item" && selectedId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`w-full text-left pl-7 pr-3 py-2 border-t border-base-300/30 hover:bg-base-200 transition-colors cursor-pointer ${
                  isItemSelected ? "bg-base-200" : ""
                }`}
                onClick={() => onSelectItem(item.id)}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  {itemIcon(item)}
                  <span className="text-xs font-medium truncate">
                    {item.summary}
                  </span>
                </div>
                {item.noteName && (
                  <div className="text-xs text-base-content/40 ml-4 truncate">
                    {item.noteName}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function itemIcon(item: SnapshotItem) {
  if (item.action === "revert") {
    return <ArrowCounterClockwise size={13} className="text-warning flex-shrink-0" />;
  }
  if (item.source === "agent") {
    return <Robot size={13} className="text-info flex-shrink-0" />;
  }
  return <User size={13} className="text-base-content/50 flex-shrink-0" />;
}

/* ── Single item detail ─────────────────────────────────── */

function SingleDetail({ detail, selectedItem, onRevert, isPending }: { detail: SnapshotDetail; selectedItem: SnapshotItem | null; onRevert: (id: string) => void; isPending: boolean }) {
  return (
    <div className="flex flex-col h-full">
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
              onClick={() => onRevert(detail.id)}
              disabled={isPending}
            >
              <ArrowCounterClockwise size={14} />
              {isPending ? "回溯中..." : "回溯到此版本"}
            </button>
          )}
          {detail.action === "revert" && selectedItem && (
            <button
              type="button"
              className="btn btn-sm btn-warning btn-outline gap-1"
              onClick={() => {
                if (detail.revertTargetId) {
                  onRevert(detail.revertTargetId);
                }
              }}
              disabled={isPending || !detail.revertTargetId}
            >
              <ArrowCounterClockwise size={14} />
              {isPending ? "取消中..." : "取消此回溯"}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <SnapshotDiffView action={detail.action} diffData={detail.diffData} />
      </div>
    </div>
  );
}

/* ── Group detail (multiple items) ──────────────────────── */

function GroupDetail({ group, onRevert, onSelectItem, isPending }: { group: SnapshotGroup; onRevert: (id: string) => void; onSelectItem: (id: string) => void; isPending: boolean }) {
  // Find the earliest snapshot for batch revert
  const earliestItem = group.items[group.items.length - 1];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-base-300 bg-base-200/30">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Stack size={16} className="text-primary" />
              <h4 className="font-semibold text-sm">{groupSummary(group)}</h4>
              <span className="badge badge-xs badge-primary">{group.items.length} 条</span>
            </div>
            <div className="text-xs text-base-content/50 mt-0.5">
              {formatDate(new Date(group.createdAt))}
              {" · "}
              {[...new Set(group.items.map((i) => i.noteName).filter(Boolean))].join("、") || "多个文件"}
            </div>
          </div>
          {earliestItem && earliestItem.action !== "revert" && (
            <button
              type="button"
              className="btn btn-sm btn-primary gap-1"
              onClick={() => onRevert(earliestItem.id)}
              disabled={isPending}
              title="回溯整组变更中最早的快照"
            >
              <ArrowCounterClockwise size={14} />
              {isPending ? "回溯中..." : "回溯整组"}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {group.items.map((item) => (
          <GroupItemCard
            key={item.id}
            item={item}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
}

/** Each item in a group gets its own component so it can safely own a useQuery hook */
function GroupItemCard({ item, onSelectItem }: { item: SnapshotItem; onSelectItem: (id: string) => void }) {
  const { data: d } = trpc.timeMachine.getDetail.useQuery({ id: item.id });

  return (
    <div className="border border-base-300 rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 bg-base-200/50 hover:bg-base-200 transition-colors cursor-pointer"
        onClick={() => onSelectItem(item.id)}
      >
        <div className="flex items-center gap-2">
          {itemIcon(item)}
          <span className="text-sm font-medium">{item.summary}</span>
          {item.noteName && (
            <span className="text-xs text-base-content/40">
              {item.noteName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-base-content/50">
            {ACTION_LABELS[item.action] ?? item.action}
          </span>
        </div>
      </button>
      {d ? (
        <div className="p-3 border-t border-base-300/50">
          <SnapshotDiffView action={d.action} diffData={d.diffData} />
        </div>
      ) : (
        <div className="flex items-center justify-center py-4">
          <span className="loading loading-spinner loading-xs" />
        </div>
      )}
    </div>
  );
}

/* ── Diff views (unchanged) ─────────────────────────────── */

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
