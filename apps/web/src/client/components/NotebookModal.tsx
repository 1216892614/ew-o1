import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";
import { NotebookIcon, AVAILABLE_ICONS } from "./NotebookIcon";

const PRESET_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
];

interface NotebookData {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  archived: boolean | null;
}

interface NotebookModalProps {
  notebook: NotebookData | null;
  onClose: () => void;
  onSaved: () => void;
}

export function NotebookModal({ notebook, onClose, onSaved }: NotebookModalProps) {
  const isEditing = notebook !== null;

  const [name, setName] = useState(notebook?.name ?? "");
  const [description, setDescription] = useState(notebook?.description ?? "");
  const [color, setColor] = useState(notebook?.color ?? "#6366f1");
  const [icon, setIcon] = useState(notebook?.icon ?? "notebook");
  const [archived, setArchived] = useState(notebook?.archived ?? false);

  const utils = trpc.useUtils();

  const updateMutation = trpc.notebooks.update.useMutation({
    onSuccess: () => {
      utils.notebooks.listInfinite.invalidate();
      onSaved();
    },
  });

  const createMutation = trpc.notebooks.create.useMutation({
    onSuccess: () => {
      utils.notebooks.listInfinite.invalidate();
      onSaved();
    },
  });

  const isPending = updateMutation.isPending || createMutation.isPending;

  function handleArchiveToggle(newValue: boolean) {
    if (!notebook) return;
    setArchived(newValue);
    updateMutation.mutate({ id: notebook.id, archived: newValue });
  }

  function handleSave() {
    if (isEditing) {
      updateMutation.mutate({
        id: notebook.id,
        name,
        description,
        color,
        icon,
      });
    } else {
      createMutation.mutate({ name, description, color, icon });
    }
  }

  return (
    <dialog className="modal modal-open">
      <div className="modal-box w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">
            {isEditing ? "编辑笔记本" : "新建笔记本"}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="form-control">
            <label className="label" htmlFor="notebook-name">
              <span className="label-text">名称</span>
            </label>
            <input
              id="notebook-name"
              type="text"
              className="input input-bordered w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="笔记本名称"
              autoFocus
            />
          </div>

          <div className="form-control">
            <label className="label" htmlFor="notebook-description">
              <span className="label-text">描述</span>
            </label>
            <textarea
              id="notebook-description"
              className="textarea textarea-bordered w-full resize-none"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简短描述这个笔记本的用途"
            />
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">颜色</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((presetColor) => (
                <button
                  key={presetColor}
                  type="button"
                  className={`w-8 h-8 rounded-full border-2 transition-transform ${
                    color === presetColor
                      ? "border-base-content scale-110"
                      : "border-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: presetColor }}
                  onClick={() => setColor(presetColor)}
                />
              ))}
            </div>
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">图标</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_ICONS.map((iconName) => (
                <button
                  key={iconName}
                  type="button"
                  className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                    icon === iconName
                      ? "border-primary bg-primary/10"
                      : "border-base-300 hover:border-primary/50"
                  }`}
                  onClick={() => setIcon(iconName)}
                >
                  <NotebookIcon icon={iconName} color={color} size={20} />
                </button>
              ))}
            </div>
          </div>

          {isEditing && (
            <div className="form-control">
              <label className="label cursor-pointer" htmlFor="notebook-archived">
                <span className="label-text">归档</span>
                <input
                  id="notebook-archived"
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={archived}
                  onChange={(e) => handleArchiveToggle(e.target.checked)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim() || isPending}
            onClick={handleSave}
          >
            {isPending ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEditing ? (
              "保存"
            ) : (
              "创建"
            )}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
