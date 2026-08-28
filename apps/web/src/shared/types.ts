import type { Env } from "hono";

export interface HonoCtxEnv extends Env {
  Bindings: Cloudflare.Env;
  Variables: {
    requestId: string;
  };
}
