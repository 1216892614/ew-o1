import {
  createRequestHandler,
  renderRouterToStream,
  RouterServer,
} from "@tanstack/react-router/ssr/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import clsx from "clsx";
import type { Context } from "hono";
import {
  Link,
  ReactRefresh,
  Script,
  ViteClient,
} from "vite-ssr-components/react";
import { createRouter } from "@/client/router";
import { trpc, trpcClient } from "@/client/lib/trpc";
import type { HonoCtxEnv } from "@/shared/types";
import themeGet from "./utils/themeGet";

export async function fileRoute(c: Context<HonoCtxEnv>) {
  const handler = createRequestHandler({
    request: c.req.raw,
    createRouter,
  });

  const [themeEl, theme] = themeGet(c);

  c.header("Content-Type", "text/html");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60,
        gcTime: 1000 * 60 * 5,
        retry: 0,
        refetchOnWindowFocus: false,
      },
    },
  });

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
            <title>ew-o1</title>
            <link rel="icon" href="/favicon.ico" sizes="48x48" />
            <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
            <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
            <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
            <ViteClient />
            <ReactRefresh />
            <Script src="/src/client/entry.client.tsx" />
            <Link href="/src/client/styles/global.css" rel="stylesheet" />
          </head>
          <body className="bg-base-100 text-base-content">
            <div id="root">
              <trpc.Provider client={trpcClient} queryClient={queryClient}>
                <QueryClientProvider client={queryClient}>
                  <RouterServer router={router} />
                </QueryClientProvider>
              </trpc.Provider>
            </div>
            {themeEl}
          </body>
        </html>
      ),
    });
  });

  return res;
}
