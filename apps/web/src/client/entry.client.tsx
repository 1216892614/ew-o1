import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterClient } from "@tanstack/react-router/ssr/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { createRouter } from "./router";
import { trpc, trpcClient } from "./lib/trpc";

window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  window.location.reload();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      gcTime: 1000 * 60 * 5,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root")!;
const router = createRouter();

hydrateRoot(
  root,
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterClient router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
