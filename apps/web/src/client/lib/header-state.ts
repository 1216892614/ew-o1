import { atom } from "jotai";
import type { ReactNode } from "react";

/** Set by child routes to inject center content into the global Header. */
export const headerCenterAtom = atom<ReactNode>(null);
