import type { Icon } from "@phosphor-icons/react";
import {
  Notebook,
  Book,
  BookOpen,
  Brain,
  Lightning,
  Star,
  Lightbulb,
  Rocket,
  Atom,
  Leaf,
} from "@phosphor-icons/react";

const ICON_MAP: Record<string, Icon> = {
  notebook: Notebook,
  book: Book,
  "book-open": BookOpen,
  brain: Brain,
  lightning: Lightning,
  star: Star,
  lightbulb: Lightbulb,
  rocket: Rocket,
  atom: Atom,
  leaf: Leaf,
};

export const AVAILABLE_ICONS = Object.keys(ICON_MAP);

interface NotebookIconProps {
  icon: string;
  color: string;
  size?: number;
}

export function NotebookIcon({ icon, color, size = 22 }: NotebookIconProps) {
  const IconComponent = ICON_MAP[icon] ?? Notebook;
  return <IconComponent size={size} weight="duotone" style={{ color }} />;
}
