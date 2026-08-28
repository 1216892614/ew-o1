import { Hono } from "hono";
import type { HonoCtxEnv } from "@/shared/types";
import { fileRoute } from "./server/fileRoute";

export const app = new Hono<HonoCtxEnv>();

// ─── SSR Catch-all ────────────────────────────────────────────────────────────
app.get("/*", fileRoute);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
