import { Hono } from "hono";
import type { HonoCtxEnv } from "@/shared/types";
import { fileRoute } from "./server/fileRoute";
import { trpcHandler } from "./server/trpc/handler";

export const app = new Hono<HonoCtxEnv>();

app.all("/api/trpc/*", trpcHandler);

app.get("/*", fileRoute);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
