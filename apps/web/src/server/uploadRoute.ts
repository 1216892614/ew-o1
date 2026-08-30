import { Hono } from "hono";
import { nanoid } from "nanoid";
import db from "@lib/db";
import { notes, categories } from "@lib/db";
import type { HonoCtxEnv } from "@/shared/types";
import { addFileToNotebookToml } from "./utils/r2Sync";

function ensureMarkdownSuffix(filename: string): string {
  if (filename.endsWith(".md")) return filename;
  return `${filename}.md`;
}

function stripExtensionForNoteName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function formatUploadCategoryName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `上传-${stamp}`;
}

export const uploadRoute = new Hono<HonoCtxEnv>();

uploadRoute.post("/api/upload", async (c) => {
  const formData = await c.req.formData();
  const notebookId = formData.get("notebookId");
  if (typeof notebookId !== "string" || !notebookId) {
    return c.json({ error: "notebookId is required" }, 400);
  }

  const files: File[] = [];
  for (const value of formData.getAll("files")) {
    if (value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }

  const database = db(c.env.DB);
  const r2 = c.env.R2;
  const now = new Date();

  let categoryId: string | null = null;
  let categoryName = "";

  // Accept pre-created categoryId from client (for progress-tracked multi-file uploads)
  const existingCategoryId = formData.get("categoryId");
  if (typeof existingCategoryId === "string" && existingCategoryId) {
    categoryId = existingCategoryId;
  } else if (files.length > 1) {
    categoryId = nanoid();
    categoryName = formatUploadCategoryName();
    await database.insert(categories).values({
      id: categoryId,
      notebookId,
      name: categoryName,
      position: Date.now(),
      createdAt: now,
    });
  }

  const createdNotes: { id: string; name: string }[] = [];

  for (const file of files) {
    const textContent = await file.text();
    const originalName = file.name || "untitled";
    const noteName = stripExtensionForNoteName(originalName);
    const r2Filename = ensureMarkdownSuffix(originalName);
    const noteId = nanoid();

    await database.insert(notes).values({
      id: noteId,
      notebookId,
      categoryId,
      name: noteName,
      content: textContent,
      wordCount: textContent.length,
      active: true,
      position: Date.now(),
      createdAt: now,
      updatedAt: now,
    });

    const r2Key = `docs/${notebookId}/${r2Filename}`;
    await r2.put(r2Key, textContent);

    await addFileToNotebookToml(r2, notebookId, {
      filename: r2Filename,
      id: noteId,
      tag: categoryName,
    });

    createdNotes.push({ id: noteId, name: noteName });
  }

  return c.json({
    uploaded: createdNotes.length,
    categoryId,
    categoryName: categoryName || null,
    notes: createdNotes,
  });
});
