import { DotsThree, Files, Clock } from "@phosphor-icons/react";
import { NotebookIcon } from "./NotebookIcon";

interface NotebookCardProps {
  name: string;
  description: string;
  color: string;
  icon: string;
  fileCount: number;
  updatedAt: Date;
  onMenuClick: () => void;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天前`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} 个月前`;

  return `${Math.floor(diffMonths / 12)} 年前`;
}

export function NotebookCard({
  name,
  description,
  color,
  icon,
  fileCount,
  updatedAt,
  onMenuClick,
}: NotebookCardProps) {
  return (
    <div className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer border border-base-300 hover:border-primary/30 group">
      <div className="card-body p-5 gap-3">
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${color}20` }}
          >
            <NotebookIcon icon={icon} color={color} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="card-title text-base font-semibold text-base-content truncate">
              {name}
            </h3>
            {description && (
              <p className="text-sm text-base-content/60 line-clamp-2 mt-1">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              onMenuClick();
            }}
          >
            <DotsThree size={18} weight="bold" />
          </button>
        </div>

        <div className="flex items-center gap-4 text-xs text-base-content/50 mt-auto pt-2 border-t border-base-300/50">
          <span className="flex items-center gap-1">
            <Files size={14} />
            {fileCount} 个文件
          </span>
          <span className="flex items-center gap-1">
            <Clock size={14} />
            {formatRelativeTime(updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
