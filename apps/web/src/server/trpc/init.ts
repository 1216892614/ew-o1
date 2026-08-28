import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Database } from "@lib/db";

export interface TrpcContext {
  db: Database;
  env: Cloudflare.Env;
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
