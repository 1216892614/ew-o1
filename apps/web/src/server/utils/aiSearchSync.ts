/**
 * AI Search index synchronization helpers.
 *
 * All notebooks share a single AI Search instance (`ew-shared`) inside the
 * bound namespace.  Documents are disambiguated at upload time via
 * `notebook_id` and `note_id` custom metadata and filtered at query time.
 *
 * The instance is lazily ensured (created if missing) on first call per
 * isolate lifetime – subsequent calls skip the create attempt.
 */

const INSTANCE_ID = "ew-shared";

let instanceReady = false;

/**
 * Lazily ensure the shared AI Search instance exists.
 * `create()` is idempotent on the server side (409 = already exists).
 */
async function ensureInstance(binding: AiSearchNamespace): Promise<AiSearchInstance> {
  if (!instanceReady) {
    try {
      await binding.create({
        id: INSTANCE_ID,
        custom_metadata: [
          { field_name: "notebook_id", data_type: "text" },
          { field_name: "note_id", data_type: "text" },
        ],
        index_method: { vector: true, keyword: true },
      });
    } catch {
      // 409 or other — instance already exists, fine
    }
    instanceReady = true;
  }
  return binding.get(INSTANCE_ID);
}

/** Upload / re-upload a note to the shared AI Search index. */
export async function upsertNoteToAiSearch(
  binding: AiSearchNamespace,
  opts: {
    notebookId: string;
    noteId: string;
    filename: string;
    content: string;
  },
): Promise<void> {
  const instance = await ensureInstance(binding);

  // AI Search keys items by filename (the `name` param).
  // We use a deterministic key so re-uploads overwrite the prior version.
  const key = `${opts.notebookId}/${opts.noteId}.md`;
  const body = `# ${opts.filename}\n\n${opts.content}`;

  try {
    await instance.items.upload(key, body, {
      metadata: {
        notebook_id: opts.notebookId,
        note_id: opts.noteId,
      },
    });
  } catch {
    // Indexing is best-effort — don't break the mutation
  }
}

/** Remove a note from the AI Search index. */
export async function deleteNoteFromAiSearch(
  binding: AiSearchNamespace,
  opts: { notebookId: string; noteId: string },
): Promise<void> {
  const instance = await ensureInstance(binding);
  const key = `${opts.notebookId}/${opts.noteId}.md`;

  try {
    // items.list filtered by key, then delete by id
    const { result } = await instance.items.list({ search: key, per_page: 1 });
    if (result.length > 0) {
      await instance.items.delete(result[0].id);
    }
  } catch {
    // best-effort
  }
}

/** Search the shared index scoped to a single notebook. */
export async function searchNotebook(
  binding: AiSearchNamespace,
  opts: {
    notebookId: string;
    query: string;
    maxResults?: number;
    noteIds?: string[];
  },
): Promise<AiSearchChunk[]> {
  const instance = await ensureInstance(binding);
  const limit = opts.maxResults ?? 5;
  const needsFilter = opts.noteIds && opts.noteIds.length > 0;
  const fetchLimit = needsFilter ? limit * 3 : limit;
  try {
    const res = await instance.search({
      messages: [{ role: "user", content: opts.query }],
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: fetchLimit,
          filters: { notebook_id: opts.notebookId },
        },
      },
    });
    let chunks = res.chunks ?? [];
    if (needsFilter) {
      const idSet = new Set(opts.noteIds);
      chunks = chunks.filter((c) => idSet.has(c.item.metadata?.note_id as string));
    }
    return chunks.slice(0, limit);
  } catch {
    return [];
  }
}
