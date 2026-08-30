import { atom } from "jotai";

export const selectedNoteIdsAtom = atom<Set<string>>(new Set<string>());

/** Ordered list of opened editor tabs */
export const openedNoteIdsAtom = atom<string[]>([]);

/** Currently active/visible tab */
export const activeNoteIdAtom = atom<string | null>(null);

/** Compat: derived atom that returns the active note id (read) or sets active+opens tab (write) */
export const openedNoteIdAtom = atom<string | null, [string | null], void>(
  (get) => get(activeNoteIdAtom),
  (get, set, noteId) => {
    if (noteId) {
      const tabs = get(openedNoteIdsAtom);
      if (!tabs.includes(noteId)) {
        set(openedNoteIdsAtom, [...tabs, noteId]);
      }
      set(activeNoteIdAtom, noteId);
    } else {
      set(activeNoteIdAtom, null);
    }
  },
);

export const sortModeAtom = atom<"latest" | "name">("latest");

/* ── Follow mode (right panel follows agent tool calls) ──── */

export interface ToolFocusRead {
  type: "read";
  fileId: string;
  filename: string;
  content: string;
  totalLines: number;
  lineStart?: number;
  lineEnd?: number;
}

export interface ToolFocusEdit {
  type: "edit";
  fileId: string;
  filename: string;
  diff: string;
  /** Result message from edit_content */
  result?: string;
}

export type ToolFocus = ToolFocusRead | ToolFocusEdit;

/** Whether follow mode is active (right panel follows tool calls) */
export const followModeAtom = atom<boolean>(true);

/** Latest tool focus event from the agent */
export const lastToolFocusAtom = atom<ToolFocus | null>(null);
