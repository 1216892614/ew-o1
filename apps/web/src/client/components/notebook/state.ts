import { atom } from "jotai";

export const selectedNoteIdsAtom = atom<Set<string>>(new Set<string>());
export const openedNoteIdAtom = atom<string | null>(null);
export const sortModeAtom = atom<"latest" | "name">("latest");
