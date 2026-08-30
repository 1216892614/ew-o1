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
