import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "@phosphor-icons/react";

interface NotebookPageHeaderProps {
  notebook: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  };
  onEditMeta: () => void;
}

export function NotebookPageHeader({
  notebook,
  onEditMeta,
}: NotebookPageHeaderProps) {
  return (
    <header className="h-12 border-b border-base-300 bg-base-100 flex items-center justify-center px-4">
      <Link to="/" className="btn btn-ghost btn-sm btn-square">
        <ArrowLeft size={20} />
      </Link>

      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={onEditMeta}
          className="cursor-pointer hover:text-primary font-semibold text-lg truncate max-w-md"
        >
          {notebook.name}
        </button>
      </div>

      <div className="w-8" />
    </header>
  );
}
