import { nanoid } from "nanoid";
import { eq, and, desc } from "drizzle-orm";
import { createPatch, applyPatch } from "diff";
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
  beforeContent?: string;
  afterContent?: string;
  metaDiff?: Record<string, { before: unknown; after: unknown }>;
  groupId?: string | null;
}

export async function recordSnapshot(params: RecordSnapshotParams): Promise<string> {
  const id = nanoid();

  let diffData: string | null = null;
  if (params.beforeContent !== undefined && params.afterContent !== undefined) {
    const patch = createPatch(
      "content",
      params.beforeContent ?? "",
      params.afterContent ?? "",
      "",
      "",
      { context: 3 },
    );
    const hasChanges = patch.includes("@@");
    diffData = hasChanges ? patch : null;
  } else if (params.metaDiff) {
    diffData = JSON.stringify(params.metaDiff);
  }

  let parentSnapshotId: string | null = null;
  if (params.noteId) {
    const [parent] = await params.db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.notebookId, params.notebookId),
          eq(snapshots.noteId, params.noteId),
        ),
      )
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    if (parent) parentSnapshotId = parent.id;
  }

  await params.db.insert(snapshots).values({
    id,
    notebookId: params.notebookId,
    noteId: params.noteId ?? null,
    action: params.action,
    summary: params.summary,
    source: params.source ?? "user",
    sessionName: params.sessionName ?? null,
    toolName: params.toolName ?? null,
    beforeData: null,
    afterData: null,
    diffData,
    parentSnapshotId,
    groupId: params.groupId ?? null,
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

export async function revertToSnapshot(
  db: Database,
  env: Cloudflare.Env,
  notebookId: string,
  targetSnapshotId: string,
): Promise<RevertSnapshotResult> {
  const [target] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.id, targetSnapshotId), eq(snapshots.notebookId, notebookId)))
    .limit(1);

  if (!target) return { success: false, error: "快照不存在" };
  if (!target.noteId) return { success: false, error: "该快照没有关联文件" };

  const [currentNote] = await db
    .select({ id: notes.id, content: notes.content, name: notes.name })
    .from(notes)
    .where(eq(notes.id, target.noteId))
    .limit(1);

  if (!currentNote) return { success: false, error: "文件不存在" };

  const targetContent = await reconstructContentAtSnapshot(db, target.noteId, targetSnapshotId);
  if (targetContent === null) {
    return { success: false, error: "无法重建该版本的内容" };
  }

  const currentContent = currentNote.content ?? "";
  const wordCount = targetContent.split(/\s+/).filter(Boolean).length;

  await db
    .update(notes)
    .set({ content: targetContent, wordCount, updatedAt: new Date() })
    .where(eq(notes.id, target.noteId));

  const { writeNoteContentToR2 } = await import("./r2Sync");
  await writeNoteContentToR2(env.R2, notebookId, `${currentNote.name}.md`, targetContent);

  const revertDiff = createPatch("content", currentContent, targetContent, "", "", { context: 3 });
  const revertId = nanoid();

  const [parentSnap] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.notebookId, notebookId),
        eq(snapshots.noteId, target.noteId),
      ),
    )
    .orderBy(desc(snapshots.createdAt))
    .limit(1);

  await db.insert(snapshots).values({
    id: revertId,
    notebookId,
    noteId: target.noteId,
    action: "revert",
    summary: `通过时光机回溯到版本 "${target.summary}"`,
    source: "user",
    sessionName: null,
    toolName: null,
    beforeData: null,
    afterData: null,
    diffData: revertDiff.includes("@@") ? revertDiff : null,
    parentSnapshotId: parentSnap?.id ?? null,
    groupId: null,
    revertTargetId: targetSnapshotId,
    createdAt: new Date(),
  });

  return { success: true, newSnapshotId: revertId };
}

async function reconstructContentAtSnapshot(
  db: Database,
  noteId: string,
  targetSnapshotId: string,
): Promise<string | null> {
  const allSnapshots = await db
    .select({
      id: snapshots.id,
      action: snapshots.action,
      diffData: snapshots.diffData,
    })
    .from(snapshots)
    .where(eq(snapshots.noteId, noteId))
    .orderBy(snapshots.createdAt);


  let content = "";
  for (const snap of allSnapshots) {
    if (snap.action === "create_note") {
      if (snap.diffData && snap.diffData.includes("@@")) {
        const result = applyPatch("", snap.diffData, { fuzzFactor: 2 });
        content = result === false ? "" : result;
      } else if (snap.diffData) {
        content = snap.diffData;
      } else {
        content = "";
      }
    } else if (snap.diffData && snap.diffData.includes("@@")) {
      const result = applyPatch(content, snap.diffData, { fuzzFactor: 2 });
      if (result !== false) content = result;
    }

    if (snap.id === targetSnapshotId) return content;
  }

  return null;
}
