import {
  createRequestHandler,
  renderRouterToStream,
  RouterServer,
} from "@tanstack/react-router/ssr/server";
import clsx from "clsx";
import type { Context } from "hono";
import {
  Link,
  ReactRefresh,
  Script,
  ViteClient,
} from "vite-ssr-components/react";
import { createRouter } from "@/client/router";
import type { HonoCtxEnv } from "@/shared/types";
import themeGet from "./utils/themeGet";

export async function fileRoute(c: Context<HonoCtxEnv>) {
  const handler = createRequestHandler({
    request: c.req.raw,
    createRouter,
  });

  const [themeEl, theme] = themeGet(c);

  c.header("Content-Type", "text/html");

  const res = handler(({ request, responseHeaders, router }) => {
    return renderRouterToStream({
      request,
      responseHeaders,
      router,
      children: (
        <html
          lang="zh-Hans"
          className={clsx({ dark: theme === "dark" }, "antialiased")}
        >
          <head>
            <meta charSet="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <title>EW-O1</title>
            <ViteClient />
            <ReactRefresh />
            <Script src="/src/client/entry.client.tsx" />
            <Link href="/src/client/styles/global.css" rel="stylesheet" />
          </head>
          <body className="bg-base-100 text-base-content">
            <div id="root">
              <RouterServer router={router} />
            </div>
            {themeEl}
          </body>
        </html>
      ),
    });
  });

  return res;
}
