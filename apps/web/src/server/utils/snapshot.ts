import { nanoid } from "nanoid";
import { eq, and, desc } from "drizzle-orm";
import { snapshots, notes } from "@lib/db";
import type { Database } from "@lib/db";

export interface RecordSnapshotParams {
  db: Database;
  notebookId: string;
  noteId?: string | null;
  action: string;
  summary: string;
  source?: "user" | "agent";
  sessionName?: string | null;
  toolName?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
}

/**
 * Record a point-in-time snapshot for the time machine.
 * Returns the new snapshot id.
 */
export async function recordSnapshot(params: RecordSnapshotParams): Promise<string> {
  const id = nanoid();
  await params.db.insert(snapshots).values({
    id,
    notebookId: params.notebookId,
    noteId: params.noteId ?? null,
    action: params.action,
    summary: params.summary,
    source: params.source ?? "user",
    sessionName: params.sessionName ?? null,
    toolName: params.toolName ?? null,
    beforeData: params.beforeData ? JSON.stringify(params.beforeData) : null,
    afterData: params.afterData ? JSON.stringify(params.afterData) : null,
    revertTargetId: null,
    createdAt: new Date(),
  });
  return id;
}

export interface RevertSnapshotResult {
  success: boolean;
  newSnapshotId?: string;
  error?: string;
}

/**
 * Revert notebook state to a given snapshot.
 *
 * Special case: if the latest snapshot is itself a revert,
 * and we're "cancelling" that revert, we delete the revert
 * record instead of stacking another revert on top.
 */
export async function revertToSnapshot(
  db: Database,
  env: Cloudflare.Env,
  notebookId: string,
  targetSnapshotId: string,
): Promise<RevertSnapshotResult> {
  // Find the target snapshot
  const [target] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.id, targetSnapshotId), eq(snapshots.notebookId, notebookId)))
    .limit(1);

  if (!target) {
    return { success: false, error: "快照不存在" };
  }

  // Find the latest snapshot for this notebook
  const [latest] = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.notebookId, notebookId))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);

  // Special case: cancel a revert by reverting it
  // If the latest entry IS a revert, and user clicks the snapshot that
  // the revert targeted (i.e. undoing the revert), just delete the
  // revert record and restore from its beforeData.
  if (
    latest &&
    latest.action === "revert" &&
    latest.revertTargetId === targetSnapshotId
  ) {
    await db.delete(snapshots).where(eq(snapshots.id, latest.id));
    if (latest.beforeData) {
      await applySnapshotData(db, notebookId, JSON.parse(latest.beforeData));
    }
    return { success: true };
  }

  // Normal revert: apply the target's afterData as current state
  if (!target.afterData) {
    return { success: false, error: "该快照没有可恢复的数据" };
  }

  // Capture current state before applying
  const currentState = await captureNoteState(db, target.noteId);

  // Apply the target snapshot's afterData
  await applySnapshotData(db, notebookId, JSON.parse(target.afterData));

  // Record a new revert snapshot
  const revertId = nanoid();
  await db.insert(snapshots).values({
    id: revertId,
    notebookId,
    noteId: target.noteId,
    action: "revert",
    summary: `通过时光机回溯到版本 "${target.summary}"`,
    source: "user",
    sessionName: null,
    toolName: null,
    beforeData: JSON.stringify(currentState),
    afterData: target.afterData,
    revertTargetId: targetSnapshotId,
    createdAt: new Date(),
  });

  return { success: true, newSnapshotId: revertId };
}

async function captureNoteState(
  db: Database,
  noteId: string | null,
): Promise<Record<string, unknown>> {
  if (!noteId) return {};
  const [note] = await db
    .select()
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  return note ? { note } : {};
}

async function applySnapshotData(
  db: Database,
  _notebookId: string,
  data: Record<string, unknown>,
): Promise<void> {
  // Restore note state
  if (data.note && typeof data.note === "object") {
    const note = data.note as Record<string, unknown>;
    if (note.id && typeof note.id === "string") {
      const [existing] = await db
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.id, note.id as string))
        .limit(1);

      if (existing) {
        await db
          .update(notes)
          .set({
            name: note.name as string,
            content: (note.content as string) ?? "",
            categoryId: (note.categoryId as string) ?? null,
            active: note.active as boolean | null,
            wordCount: note.wordCount as number | null,
            updatedAt: new Date(),
          })
          .where(eq(notes.id, note.id as string));
      }
    }
  }
}
