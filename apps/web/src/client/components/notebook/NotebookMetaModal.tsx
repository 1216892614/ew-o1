import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { trpc } from "@/client/lib/trpc";

interface NotebookMetaModalProps {
  notebook: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  };
  onClose: () => void;
}

export function NotebookMetaModal({ notebook, onClose }: NotebookMetaModalProps) {
  const [name, setName] = useState(notebook.name);
  const [description, setDescription] = useState(notebook.description ?? "");
  const utils = trpc.useUtils();

  const updateMutation = trpc.notebooks.update.useMutation({
    onSuccess: () => {
      utils.notes.getNotebook.invalidate({ id: notebook.id });
      onClose();
    },
  });

  function handleSave() {
    if (!name.trim()) return;
    updateMutation.mutate({ id: notebook.id, name: name.trim(), description });
  }

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Edit Notebook</h3>
          <button type="button" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="form-control">
            <label className="label">
              <span className="label-text">Name</span>
            </label>
            <input
              type="text"
              className="input input-bordered w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">Description</span>
            </label>
            <textarea
              className="textarea textarea-bordered w-full"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={updateMutation.isPending || !name.trim()}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
