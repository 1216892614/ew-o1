import {
  parseNotebookToml,
  serializeNotebookToml,
  emptyNotebookToml,
  type NotebookToml,
  type NotebookTomlMeta,
  type NotebookTomlFile,
} from "@lib/db";

function tomlKey(notebookId: string): string {
  return `docs/${notebookId}/ew-o1.toml`;
}

/**
 * Read and parse `ew-o1.toml` from R2.
 *
 * Returns a well-formed `NotebookToml` in all cases:
 * - Object missing → empty toml (no files)
 * - Toml with `[meta]` only, no `[[files]]` → meta populated, files = []
 * - Malformed TOML → falls back to empty toml
 */
export async function readNotebookTomlFromR2(
  r2: R2Bucket,
  notebookId: string,
): Promise<NotebookToml> {
  const object = await r2.get(tomlKey(notebookId));
  if (!object) return emptyNotebookToml();

  const raw = await object.text();
  if (!raw.trim()) return emptyNotebookToml();

  try {
    return parseNotebookToml(raw);
  } catch {
    return emptyNotebookToml();
  }
}

/**
 * Write `ew-o1.toml` to R2 from a complete `NotebookToml`.
 */
export async function writeNotebookTomlToR2(
  r2: R2Bucket,
  notebookId: string,
  toml: NotebookToml,
): Promise<void> {
  const serialized = serializeNotebookToml(toml);
  await r2.put(tomlKey(notebookId), serialized);
}

/**
 * Update only the `[meta]` section and write back.
 * Preserves existing `[[files]]` entries.
 */
export async function updateNotebookMetaInR2(
  r2: R2Bucket,
  notebookId: string,
  metaUpdates: Partial<NotebookTomlMeta>,
): Promise<void> {
  const existing = await readNotebookTomlFromR2(r2, notebookId);
  const updatedToml: NotebookToml = {
    meta: { ...existing.meta, ...metaUpdates, updated_at: new Date() },
    files: existing.files,
  };
  await writeNotebookTomlToR2(r2, notebookId, updatedToml);
}

/**
 * Add a file entry to the `[[files]]` array and write back.
 * No-op if a file with the same `id` already exists.
 */
export async function addFileToNotebookToml(
  r2: R2Bucket,
  notebookId: string,
  file: NotebookTomlFile,
): Promise<void> {
  const existing = await readNotebookTomlFromR2(r2, notebookId);
  if (existing.files.some((f) => f.id === file.id)) return;

  existing.files.push(file);
  existing.meta.updated_at = new Date();
  await writeNotebookTomlToR2(r2, notebookId, existing);
}

/**
 * Remove a file entry from the `[[files]]` array by ID and write back.
 * No-op if the file is not found.
 */
export async function removeFileFromNotebookToml(
  r2: R2Bucket,
  notebookId: string,
  fileId: string,
): Promise<void> {
  const existing = await readNotebookTomlFromR2(r2, notebookId);
  const filtered = existing.files.filter((f) => f.id !== fileId);
  if (filtered.length === existing.files.length) return;

  existing.files = filtered;
  existing.meta.updated_at = new Date();
  await writeNotebookTomlToR2(r2, notebookId, existing);
}

/**
 * Update a file entry's metadata (filename, tag) in the `[[files]]` array.
 */
export async function updateFileInNotebookToml(
  r2: R2Bucket,
  notebookId: string,
  fileId: string,
  updates: Partial<Omit<NotebookTomlFile, "id">>,
): Promise<void> {
  const existing = await readNotebookTomlFromR2(r2, notebookId);
  const file = existing.files.find((f) => f.id === fileId);
  if (!file) return;

  if (updates.filename !== undefined) file.filename = updates.filename;
  if (updates.tag !== undefined) file.tag = updates.tag;
  existing.meta.updated_at = new Date();
  await writeNotebookTomlToR2(r2, notebookId, existing);
}
