import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { HonoCtxEnv } from "@/shared/types";

export default function themeGet(c: Context<HonoCtxEnv>) {
  const cookieTheme = getCookie(c, "ew-theme");
  const theme = cookieTheme === "light" ? "light" : "dark";
  setCookie(c, "ew-theme", theme, { path: "/", sameSite: "Lax" });

  return [
    <div key="theme" className="size-0 opacity-0 overflow-hidden pointer-events-none">
      <input
        value="light"
        type="checkbox"
        id="ew-theme-controller"
        defaultChecked={theme === "light"}
        className="theme-controller"
      />
    </div>,
    theme,
  ] as const;
}
