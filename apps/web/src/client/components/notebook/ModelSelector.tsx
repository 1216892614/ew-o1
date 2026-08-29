import { useState } from "react";
import { X, Brain, Lightning, Check } from "@phosphor-icons/react";

export type ThinkingLevel = "low" | "medium" | "high";

export type ModelInfo = {
  id: string;
  name: string;
  provider: "Anthropic" | "OpenAI" | "DeepSeek" | "xAI" | "MiniMax";
  thinking?: boolean;
  free?: boolean;
};

export type ModelParams = {
  /** Only for non-thinking models */
  temperature?: number;
  /** Only for non-thinking models */
  topP?: number;
  /** Only for thinking models */
  thinkingLevel?: ThinkingLevel;
  /** Max tokens per round (every model) */
  maxPerRound: number;
};

export type ModelConfig = {
  model: ModelInfo;
  params: ModelParams;
};

export const MODELS: ModelInfo[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "Anthropic" },
  { id: "claude-sonnet-5-thinking", name: "Claude Sonnet 5 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "Anthropic" },
  { id: "claude-opus-5-thinking", name: "Claude Opus 5 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "Anthropic" },
  { id: "claude-opus-4-8-thinking", name: "Claude Opus 4.8 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "Anthropic" },
  { id: "claude-opus-4-7-thinking", name: "Claude Opus 4.7 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic" },
  { id: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 Thinking", provider: "Anthropic", thinking: true },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "Anthropic" },
  { id: "claude-haiku-4-5-20251001-thinking", name: "Claude Haiku 4.5 Thinking", provider: "Anthropic", thinking: true },
  { id: "composer-2.5", name: "Composer 2.5", provider: "Anthropic" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "OpenAI" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "OpenAI" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "OpenAI" },
  { id: "gpt-5.4", name: "GPT-5.4", provider: "OpenAI" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "OpenAI" },
  { id: "gpt-oss-120b-free", name: "GPT-OSS 120B", provider: "OpenAI", free: true },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "DeepSeek" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "DeepSeek" },
  { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", provider: "DeepSeek", free: true },
  { id: "grok-4.6", name: "Grok 4.6", provider: "xAI" },
  { id: "grok-4.5", name: "Grok 4.5", provider: "xAI" },
  { id: "musk-4.5", name: "Musk 4.5", provider: "xAI" },
  { id: "minimax-m3", name: "MiniMax M3", provider: "MiniMax" },
  { id: "minimax-m2.7-free", name: "MiniMax M2.7", provider: "MiniMax", free: true },
];

function buildDefaultParams(model: ModelInfo): ModelParams {
  if (model.thinking) {
    return { thinkingLevel: "medium", maxPerRound: 16384 };
  }
  return { temperature: 0.7, topP: 1, maxPerRound: 8192 };
}

export function getDefaultModelConfig(): ModelConfig {
  const model = MODELS[0];
  return { model, params: buildDefaultParams(model) };
}

const PROVIDERS = ["All", "Anthropic", "OpenAI", "DeepSeek", "xAI", "MiniMax"] as const;

type Props = {
  currentConfig: ModelConfig;
  onConfirm: (config: ModelConfig) => void;
  onClose: () => void;
};

export function ModelSelector({ currentConfig, onConfirm, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<(typeof PROVIDERS)[number]>("All");
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(currentConfig.model);
  const [paramValues, setParamValues] = useState<ModelParams>(currentConfig.params);

  function handleSelectModel(model: ModelInfo) {
    setSelectedModel(model);
    // Reset params to defaults for the new model type
    if (model.id !== currentConfig.model.id) {
      setParamValues(buildDefaultParams(model));
    }
  }

  function handleConfirm() {
    onConfirm({ model: selectedModel, params: paramValues });
  }

  const filtered = MODELS.filter((m) => {
    const matchesProvider = activeTab === "All" || m.provider === activeTab;
    const matchesSearch =
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase());
    return matchesProvider && matchesSearch;
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h3 className="text-lg font-bold">Model Configuration</h3>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left: Model List */}
          <div className="flex-1 flex flex-col min-w-0">
            <div role="tablist" className="tabs tabs-bordered mb-2 flex-wrap shrink-0">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider}
                  role="tab"
                  className={`tab tab-sm ${activeTab === provider ? "tab-active" : ""}`}
                  onClick={() => setActiveTab(provider)}
                >
                  {provider}
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder="Search models..."
              className="input input-bordered input-sm w-full mb-2 shrink-0"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <div className="overflow-y-auto flex-1 space-y-1 pr-1">
              {filtered.map((model) => {
                const isSelected = model.id === selectedModel.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className={`w-full text-left px-2.5 py-2 rounded-lg cursor-pointer border transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-transparent hover:bg-base-200"
                    }`}
                    onClick={() => handleSelectModel(model)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-sm truncate">{model.name}</span>
                      {model.thinking && (
                        <Brain size={12} className="text-warning shrink-0" />
                      )}
                      {model.free && (
                        <Lightning size={12} className="text-success shrink-0" />
                      )}
                    </div>
                    <div className="text-[11px] text-base-content/40 font-mono truncate">
                      {model.id}
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

          {/* Right: Parameters */}
          <div className="w-56 shrink-0 border-l border-base-300 pl-4 flex flex-col">
            <div className="text-sm font-semibold mb-3 text-base-content/70">Parameters</div>
            <div className="flex-1 overflow-y-auto space-y-5">
              {selectedModel.thinking ? (
                /* Thinking model: level selector */
                <ThinkingLevelSelector
                  value={paramValues.thinkingLevel ?? "medium"}
                  onChange={(level) =>
                    setParamValues((prev) => ({ ...prev, thinkingLevel: level }))
                  }
                />
              ) : (
                /* Normal model: temperature + top_p */
                <>
                  <SliderParam
                    label="Temperature"
                    min={0}
                    max={2}
                    step={0.1}
                    value={paramValues.temperature ?? 0.7}
                    onChange={(v) =>
                      setParamValues((prev) => ({ ...prev, temperature: v }))
                    }
                  />
                  <SliderParam
                    label="Top P"
                    min={0}
                    max={1}
                    step={0.05}
                    value={paramValues.topP ?? 1}
                    onChange={(v) =>
                      setParamValues((prev) => ({ ...prev, topP: v }))
                    }
                  />
                </>
              )}

              {/* All models: max per round */}
              <SliderParam
                label="Max Per Round"
                min={512}
                max={32768}
                step={512}
                value={paramValues.maxPerRound}
                onChange={(v) =>
                  setParamValues((prev) => ({ ...prev, maxPerRound: v }))
                }
                integer
              />
            </div>

            <button
              type="button"
              className="btn btn-primary btn-sm mt-4 w-full shrink-0"
              onClick={handleConfirm}
            >
              <Check size={14} />
              Confirm
            </button>
          </div>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

function ThinkingLevelSelector({
  value,
  onChange,
}: {
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  const levels: { value: ThinkingLevel; label: string; desc: string }[] = [
    { value: "low", label: "Low", desc: "Fast, less reasoning" },
    { value: "medium", label: "Medium", desc: "Balanced" },
    { value: "high", label: "High", desc: "Deep reasoning" },
  ];

  return (
    <div>
      <label className="text-xs font-medium mb-2 block">Thinking Level</label>
      <div className="flex flex-col gap-1.5">
        {levels.map((level) => (
          <button
            key={level.value}
            type="button"
            className={`text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors ${
              value === level.value
                ? "border-warning bg-warning/10 text-warning-content"
                : "border-base-300 hover:bg-base-200"
            }`}
            onClick={() => onChange(level.value)}
          >
            <div className="font-medium">{level.label}</div>
            <div className="text-[10px] text-base-content/50">{level.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SliderParam({
  label,
  min,
  max,
  step,
  value,
  onChange,
  integer,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  integer?: boolean;
}) {
  const displayValue = integer ? Math.round(value) : value.toFixed(step < 0.1 ? 2 : 1);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium">{label}</label>
        <span className="text-xs font-mono text-base-content/60">{displayValue}</span>
      </div>
      <input
        type="range"
        className="range range-xs range-primary w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="flex justify-between text-[10px] text-base-content/40 mt-0.5">
        <span>{integer ? min : min.toFixed(step < 0.1 ? 2 : 1)}</span>
        <span>{integer ? max : max.toFixed(step < 0.1 ? 2 : 1)}</span>
      </div>
    </div>
  );
}
