import { MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react/dist/ssr";
import clsx from "clsx";
import { atom, useAtom } from "jotai";
import Cookie from "js-cookie";
import { useEffect } from "react";

export type ThemeValue = "system" | "light" | "dark";

export const themeAtom = atom<ThemeValue | null>(null);

function resolveThemeClass(theme: ThemeValue): boolean {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return theme === "dark";
}

function applyTheme(theme: ThemeValue) {
  const isDark = resolveThemeClass(theme);
  document.documentElement.classList.toggle("dark", isDark);

  const input = document.getElementById("ew-theme-controller") as HTMLInputElement | null;
  if (input) {
    input.checked = !isDark;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const cycle: ThemeValue[] = ["system", "light", "dark"];

export default function ThemeSwitcher({ className }: { className?: string }) {
  const [theme, setTheme] = useAtom(themeAtom);

  // Initialize from SSR cookie on mount
  useEffect(() => {
    if (typeof window === "undefined" || theme !== null) return;

    const stored = Cookie.get("ew-theme");
    const initial: ThemeValue =
      stored === "light" || stored === "dark" ? stored : "system";
    setTheme(initial);
  }, [theme, setTheme]);

  // Apply theme changes
  useEffect(() => {
    if (typeof window === "undefined" || theme === null) return;

    applyTheme(theme);
    Cookie.set("ew-theme", theme, { path: "/", sameSite: "Lax" });

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  const next = () => {
    const idx = cycle.indexOf(theme ?? "system");
    setTheme(cycle[(idx + 1) % cycle.length]);
  };

  const iconClass = "size-5";

  return (
    <button
      type="button"
      className={clsx("btn btn-ghost btn-sm btn-square", className)}
      onClick={next}
      aria-label="切换主题"
      title={theme ?? "system"}
    >
      {theme === "light" && <SunIcon className={iconClass} weight="fill" />}
      {theme === "dark" && <MoonIcon className={iconClass} weight="fill" />}
      {(theme === "system" || theme === null) && (
        <MonitorIcon className={iconClass} weight="fill" />
      )}
    </button>
  );
}
