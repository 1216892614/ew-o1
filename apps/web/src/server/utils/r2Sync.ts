import {
  parseNotebookToml,
  serializeNotebookToml,
  emptyNotebookToml,
  type NotebookToml,
  type NotebookTomlMeta,
  type NotebookTomlFile,
  notes,
  categories,
  notebooks,
} from "@lib/db";
import type { Database } from "@lib/db";
import { eq, and, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

function tomlKey(notebookId: string): string {
  return `docs/${notebookId}/ew-o1.toml`;
}

function noteR2Key(notebookId: string, filename: string): string {
  return `docs/${notebookId}/${filename}`;
}

export async function writeNoteContentToR2(
  r2: R2Bucket,
  notebookId: string,
  filename: string,
  content: string,
): Promise<void> {
  await r2.put(noteR2Key(notebookId, filename), content);
}

export async function deleteNoteContentFromR2(
  r2: R2Bucket,
  notebookId: string,
  filename: string,
): Promise<void> {
  await r2.delete(noteR2Key(notebookId, filename));
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

function computeWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

export async function syncNotebookFromR2ToD1(
  r2: R2Bucket,
  db: Database,
  notebookId: string,
): Promise<void> {
  const toml = await readNotebookTomlFromR2(r2, notebookId);

  await db
    .update(notebooks)
    .set({
      name: toml.meta.name || notebookId,
      description: toml.meta.description || "",
      color: toml.meta.color || "#6366f1",
      icon: toml.meta.icon || "notebook",
      fileCount: toml.files.length,
      updatedAt: toml.meta.updated_at ?? new Date(),
    })
    .where(eq(notebooks.id, notebookId));

  if (toml.files.length === 0) {
    await db
      .delete(notes)
      .where(eq(notes.notebookId, notebookId));
    await deleteOrphanCategories(db, notebookId);
    return;
  }

  const tagToCategoryId = await upsertCategoriesFromTags(db, notebookId, toml.files);

  const tomlFileIds = toml.files.map((f) => f.id);

  for (const file of toml.files) {
    const content = await readNoteContent(r2, notebookId, file.filename);
    const categoryId = file.tag ? (tagToCategoryId.get(file.tag) ?? null) : null;
    await upsertNote(db, notebookId, file, content, categoryId);
  }

  await db
    .delete(notes)
    .where(
      and(
        eq(notes.notebookId, notebookId),
        notInArray(notes.id, tomlFileIds),
      ),
    );

  await deleteOrphanCategories(db, notebookId);
}

async function readNoteContent(
  r2: R2Bucket,
  notebookId: string,
  filename: string,
): Promise<string> {
  const object = await r2.get(noteR2Key(notebookId, filename));
  if (!object) return "";
  return object.text();
}

async function upsertNote(
  db: Database,
  notebookId: string,
  file: NotebookTomlFile,
  content: string,
  categoryId: string | null,
): Promise<void> {
  const now = new Date();
  const wordCount = computeWordCount(content);
  const name = file.filename.replace(/\.md$/, "");

  const [existing] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.id, file.id))
    .limit(1);

  if (existing) {
    await db
      .update(notes)
      .set({ name, content, wordCount, categoryId, updatedAt: now })
      .where(eq(notes.id, file.id));
  } else {
    await db.insert(notes).values({
      id: file.id,
      notebookId,
      categoryId,
      name,
      content,
      wordCount,
      position: Date.now(),
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function upsertCategoriesFromTags(
  db: Database,
  notebookId: string,
  files: NotebookTomlFile[],
): Promise<Map<string, string>> {
  const uniqueTags = [...new Set(files.map((f) => f.tag).filter(Boolean))];
  const tagToCategoryId = new Map<string, string>();

  const existingCategories = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.notebookId, notebookId));

  const catByName = new Map(existingCategories.map((c) => [c.name, c.id]));

  for (const tag of uniqueTags) {
    const existingId = catByName.get(tag);
    if (existingId) {
      tagToCategoryId.set(tag, existingId);
    } else {
      const id = nanoid();
      await db.insert(categories).values({
        id,
        notebookId,
        name: tag,
        position: Date.now(),
        createdAt: new Date(),
      });
      tagToCategoryId.set(tag, id);
    }
  }

  return tagToCategoryId;
}

async function deleteOrphanCategories(
  db: Database,
  notebookId: string,
): Promise<void> {
  const allCats = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.notebookId, notebookId));

  for (const cat of allCats) {
    const [row] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.categoryId, cat.id))
      .limit(1);

    if (!row) {
      await db.delete(categories).where(eq(categories.id, cat.id));
    }
  }
}

/**
 * Scan R2 for all `docs/<id>/ew-o1.toml`, discover notebooks not yet in D1,
 * create missing notebook rows, and sync every notebook's notes from R2.
 */
export async function discoverAndSyncAllFromR2(
  r2: R2Bucket,
  db: Database,
): Promise<{ discovered: number; synced: number }> {
  // List all objects under docs/ matching the toml pattern
  const notebookIds: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix: "docs/", cursor, limit: 500 });
    for (const obj of listed.objects) {
      const match = obj.key.match(/^docs\/([^/]+)\/ew-o1\.toml$/);
      if (match) notebookIds.push(match[1]);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (notebookIds.length === 0) return { discovered: 0, synced: 0 };

  // Find which notebooks already exist in D1
  const existingRows = await db
    .select({ id: notebooks.id })
    .from(notebooks);
  const existingIds = new Set(existingRows.map((r) => r.id));

  let discovered = 0;

  for (const nbId of notebookIds) {
    const toml = await readNotebookTomlFromR2(r2, nbId);

    // Create notebook row if missing
    if (!existingIds.has(nbId)) {
      const now = new Date();
      await db.insert(notebooks).values({
        id: nbId,
        name: toml.meta.name || nbId,
        description: toml.meta.description || "",
        color: toml.meta.color || "#6366f1",
        icon: toml.meta.icon || "notebook",
        fileCount: toml.files.length,
        archived: false,
        updatedAt: toml.meta.updated_at ?? now,
        createdAt: now,
      });
      discovered++;
    }

    // Sync notes from R2 → D1
    await syncNotebookFromR2ToD1(r2, db, nbId);

  }

  return { discovered, synced: notebookIds.length };
}

export async function bumpNotebookTimestamps(
  r2: R2Bucket,
  db: Database,
  notebookId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(notebooks)
    .set({ updatedAt: now })
    .where(eq(notebooks.id, notebookId));
  await updateNotebookMetaInR2(r2, notebookId, { updated_at: now });
}

export async function updateNotebookFileCount(
  db: Database,
  notebookId: string,
): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notes)
    .where(and(eq(notes.notebookId, notebookId), eq(notes.archived, false)));
  await db
    .update(notebooks)
    .set({ fileCount: row?.count ?? 0, updatedAt: new Date() })
    .where(eq(notebooks.id, notebookId));
}
