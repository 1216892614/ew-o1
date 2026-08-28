import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { Context } from "hono";
import db from "@lib/db";
import type { HonoCtxEnv } from "@/shared/types";
import { appRouter } from "./router";
import type { TrpcContext } from "./init";

export function trpcHandler(c: Context<HonoCtxEnv>) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (): TrpcContext => ({
      db: db(c.env.DB),
      env: c.env,
    }),
  });
}
