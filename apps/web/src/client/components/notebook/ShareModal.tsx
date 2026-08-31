import { useState, useEffect, useMemo } from "react";
import { X, ArrowsClockwise, Copy, Check, LinkSimple } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";

interface ShareModalProps {
  notebookId: string;
  onClose: () => void;
}

const TTL_OPTIONS = [
  { label: "永不过期", value: 0 },
  { label: "1 小时", value: 3600 },
  { label: "24 小时", value: 86400 },
  { label: "7 天", value: 604800 },
  { label: "30 天", value: 2592000 },
];

const ARCHIVE_TAG = "__archived__";

export function ShareModal({ notebookId, onClose }: ShareModalProps) {
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.share.get.useQuery({ notebookId });
  const share = data?.share ?? null;
  const tags = data?.tags ?? [];

  const [ttlSeconds, setTtlSeconds] = useState(604800);
  const [hiddenTags, setHiddenTags] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // Sync defaults from server data
  useEffect(() => {
    if (share) {
      setHiddenTags(new Set(share.hiddenTags));
      if (share.expiresAt > 0) {
        const remaining = Math.max(0, share.expiresAt - Date.now());
        const remainingSec = Math.floor(remaining / 1000);
        const match = TTL_OPTIONS.find(
          (o) => o.value > 0 && Math.abs(o.value - remainingSec) < o.value * 0.3,
        );
        setTtlSeconds(match?.value ?? 86400);
      }
    } else {
      // Default: hide archived
      const defaults = new Set<string>();
      if (tags.includes(ARCHIVE_TAG)) defaults.add(ARCHIVE_TAG);
      setHiddenTags(defaults);
    }
  }, [share, tags]);

  const upsertMutation = trpc.share.upsert.useMutation({
    onSuccess: () => utils.share.get.invalidate({ notebookId }),
  });
  const refreshMutation = trpc.share.refreshCode.useMutation({
    onSuccess: () => utils.share.get.invalidate({ notebookId }),
  });
  const deleteMutation = trpc.share.delete.useMutation({
    onSuccess: () => utils.share.get.invalidate({ notebookId }),
  });

  function handleSave() {
    upsertMutation.mutate({
      notebookId,
      hiddenTags: [...hiddenTags],
      ttlSeconds,
    });
  }

  function handleToggleTag(tag: string) {
    setHiddenTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  const shareUrl = useMemo(() => {
    if (!share) return null;
    return `${window.location.origin}/notebook/s/${notebookId}?code=${share.code}`;
  }, [share, notebookId]);

  async function handleCopy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const expiryLabel = useMemo(() => {
    if (!share || share.expiresAt === 0) return null;
    return new Date(share.expiresAt).toLocaleString();
  }, [share]);

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">分享 Notebook</h3>
          <button type="button" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Share URL */}
            {share && shareUrl ? (
              <div className="space-y-2">
                <label className="label"><span className="label-text font-medium">分享链接</span></label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="input input-bordered input-sm flex-1 font-mono text-xs"
                    value={shareUrl}
                    readOnly
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-square"
                    onClick={handleCopy}
                    title="复制链接"
                  >
                    {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-square"
                    onClick={() => refreshMutation.mutate({ notebookId })}
                    disabled={refreshMutation.isPending}
                    title="刷新密码 (旧链接失效)"
                  >
                    <ArrowsClockwise size={16} className={refreshMutation.isPending ? "animate-spin" : ""} />
                  </button>
                </div>
                {expiryLabel && (
                  <p className="text-xs text-base-content/50">过期时间: {expiryLabel}</p>
                )}
              </div>
            ) : (
              <div className="bg-base-200 rounded-lg p-4 text-center text-sm text-base-content/60">
                <LinkSimple size={24} className="mx-auto mb-2 opacity-50" />
                尚未创建分享链接
              </div>
            )}

            {/* Expiry */}
            <div>
              <label className="label"><span className="label-text font-medium">过期时间</span></label>
              <select
                className="select select-bordered w-full select-sm"
                value={ttlSeconds}
                onChange={(e) => setTtlSeconds(Number(e.target.value))}
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Hidden tags */}
            {tags.length > 0 && (
              <div>
                <label className="label"><span className="label-text font-medium">隐藏分类</span></label>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {tags.map((tag) => (
                    <label key={tag} className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-base-200">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={hiddenTags.has(tag)}
                        onChange={() => handleToggleTag(tag)}
                      />
                      <span className="text-sm">{tag === ARCHIVE_TAG ? "已归档" : tag}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="modal-action">
          {share && (
            <button
              type="button"
              className="btn btn-error btn-sm mr-auto"
              onClick={() => deleteMutation.mutate({ notebookId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "删除中..." : "删除链接"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={upsertMutation.isPending}
          >
            {upsertMutation.isPending ? "保存中..." : share ? "更新" : "创建链接"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
