import { useState } from "react";
import { X, Eye, Lightning } from "@phosphor-icons/react";

export type ModelInfo = {
  id: string;
  name: string;
  provider: "OpenAI" | "Anthropic" | "Google" | "Meta";
  params: string[];
  context: number;
  pricing: string;
  multimodal: boolean;
  nativeCompression: boolean;
};

export const MODELS: ModelInfo[] = [
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", params: ["temperature", "top_p", "max_tokens"], context: 128000, pricing: "$2.5/1M input", multimodal: true, nativeCompression: false },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", params: ["temperature", "top_p", "max_tokens"], context: 128000, pricing: "$0.15/1M input", multimodal: true, nativeCompression: false },
  { id: "claude-4-opus", name: "Claude 4 Opus", provider: "Anthropic", params: ["temperature", "top_k", "max_tokens"], context: 200000, pricing: "$15/1M input", multimodal: true, nativeCompression: true },
  { id: "claude-4-sonnet", name: "Claude 4 Sonnet", provider: "Anthropic", params: ["temperature", "top_k", "max_tokens"], context: 200000, pricing: "$3/1M input", multimodal: true, nativeCompression: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", params: ["temperature", "top_p", "top_k", "max_tokens"], context: 1000000, pricing: "$1.25/1M input", multimodal: true, nativeCompression: false },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", params: ["temperature", "top_p", "max_tokens"], context: 1000000, pricing: "$0.15/1M input", multimodal: true, nativeCompression: false },
  { id: "llama-4-maverick", name: "Llama 4 Maverick", provider: "Meta", params: ["temperature", "top_p", "max_tokens"], context: 128000, pricing: "Open weight", multimodal: true, nativeCompression: false },
  { id: "llama-4-scout", name: "Llama 4 Scout", provider: "Meta", params: ["temperature", "top_p", "max_tokens"], context: 512000, pricing: "Open weight", multimodal: false, nativeCompression: false },
];

const PROVIDERS = ["All", "OpenAI", "Anthropic", "Google", "Meta"] as const;

type Props = {
  onSelect: (model: ModelInfo) => void;
  onClose: () => void;
  currentModelId?: string;
};

function formatContext(tokens: number): string {
  if (tokens >= 1000000) return `${tokens / 1000000}M ctx`;
  return `${tokens / 1000}K ctx`;
}

export function ModelSelector({ onSelect, onClose, currentModelId }: Props) {
  const [activeTab, setActiveTab] = useState<(typeof PROVIDERS)[number]>("All");
  const [search, setSearch] = useState("");

  const filtered = MODELS.filter((m) => {
    const matchesProvider = activeTab === "All" || m.provider === activeTab;
    const matchesSearch = m.name.toLowerCase().includes(search.toLowerCase());
    return matchesProvider && matchesSearch;
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">Select Model</h3>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div role="tablist" className="tabs tabs-bordered mb-3">
          {PROVIDERS.map((provider) => (
            <button
              key={provider}
              role="tab"
              className={`tab ${activeTab === provider ? "tab-active" : ""}`}
              onClick={() => setActiveTab(provider)}
            >
              {provider}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search models..."
          className="input input-bordered input-sm w-full mb-3"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="overflow-y-auto max-h-80 space-y-2">
          {filtered.map((model) => {
            const isActive = model.id === currentModelId;
            return (
              <button
                key={model.id}
                type="button"
                className={`w-full text-left p-3 rounded-lg cursor-pointer border mb-2 transition-colors ${
                  isActive
                    ? "border-primary bg-primary/10"
                    : "border-base-300 hover:bg-base-200"
                }`}
                onClick={() => onSelect(model)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{model.name}</span>
                  <span className="badge badge-sm">{model.provider}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-base-content/60 mt-1">
                  <span>{formatContext(model.context)}</span>
                  <span>{model.pricing}</span>
                  {model.multimodal && (
                    <span className="flex items-center gap-0.5" title="Multimodal">
                      <Eye size={12} />
                      <span>Multimodal</span>
                    </span>
                  )}
                  {model.nativeCompression && (
                    <span className="flex items-center gap-0.5" title="Native compression">
                      <Lightning size={12} />
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {model.params.map((p) => (
                    <span key={p} className="badge badge-xs badge-outline">
                      {p}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="text-center text-sm text-base-content/50 py-4">
              No models found
            </p>
          )}
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
