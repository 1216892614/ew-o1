import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { HonoCtxEnv } from "@/shared/types";

export default function themeGet(c: Context<HonoCtxEnv>) {
  const cookieTheme = getCookie(c, "ew-theme");
  // "system" | "light" | "dark"; default to system
  const stored = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : "system";
  // For SSR class, system defaults to dark (client will correct on hydration)
  const resolvedClass = stored === "light" ? "light" : "dark";

  if (!cookieTheme) {
    setCookie(c, "ew-theme", "system", { path: "/", sameSite: "Lax" });
  }

  return [
    <div key="theme" className="size-0 opacity-0 overflow-hidden pointer-events-none">
      <input
        value="light"
        type="checkbox"
        id="ew-theme-controller"
        defaultChecked={stored === "light"}
        className="theme-controller"
      />
    </div>,
    resolvedClass,
  ] as const;
}
