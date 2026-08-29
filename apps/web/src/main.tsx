import { Hono } from "hono";
import type { HonoCtxEnv } from "@/shared/types";
import { fileRoute } from "./server/fileRoute";
import { trpcHandler } from "./server/trpc/handler";
import { chatRoute } from "./server/chat/route";

export { ChatSessionDO } from "./server/chat/ChatSessionDO";

export const app = new Hono<HonoCtxEnv>();

app.route("/", chatRoute);
app.all("/api/trpc/*", trpcHandler);

app.get("/*", fileRoute);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
