import { parse, stringify } from "smol-toml";

export interface NotebookTomlMeta {
  name: string;
  description: string;
  color: string;
  icon: string;
  updated_at: Date;
}

export interface NotebookTomlFile {
  filename: string;
  id: string;
  tag: string;
}

export interface NotebookToml {
  meta: NotebookTomlMeta;
  files: NotebookTomlFile[];
}

interface RawTomlData {
  meta?: {
    name?: string;
    description?: string;
    color?: string;
    icon?: string;
    updated_at?: Date | string;
  };
  files?: Array<{
    filename?: string;
    id?: string;
    tag?: string;
  }>;
}

export function parseNotebookToml(raw: string): NotebookToml {
  const data = parse(raw) as RawTomlData;

  const meta = data.meta ?? {};

  const updatedAt =
    meta.updated_at instanceof Date
      ? meta.updated_at
      : typeof meta.updated_at === "string"
        ? new Date(meta.updated_at)
        : new Date();

  return {
    meta: {
      name: meta.name ?? "",
      description: meta.description ?? "",
      color: meta.color ?? "#6366f1",
      icon: meta.icon ?? "notebook",
      updated_at: updatedAt,
    },
    files: Array.isArray(data.files)
      ? data.files
          .filter(
            (f): f is { filename: string; id: string; tag: string } =>
              typeof f.filename === "string" && typeof f.id === "string",
          )
          .map((f) => ({
            filename: f.filename,
            id: f.id,
            tag: f.tag ?? "",
          }))
      : [],
  };
}

export function serializeNotebookToml(toml: NotebookToml): string {
  const data: Record<string, unknown> = {
    meta: {
      name: toml.meta.name,
      description: toml.meta.description,
      color: toml.meta.color,
      icon: toml.meta.icon,
      updated_at: toml.meta.updated_at,
    },
  };

  if (toml.files.length > 0) {
    data.files = toml.files.map((f) => ({
      filename: f.filename,
      id: f.id,
      tag: f.tag,
    }));
  }

  return stringify(data);
}

/**
 * Build an empty NotebookToml — the canonical representation of a
 * notebook that has no ew-o1.toml on R2 yet.
 */
export function emptyNotebookToml(): NotebookToml {
  return {
    meta: {
      name: "",
      description: "",
      color: "#6366f1",
      icon: "notebook",
      updated_at: new Date(),
    },
    files: [],
  };
}
