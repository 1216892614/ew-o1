import { RouterClient } from "@tanstack/react-router/ssr/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { createRouter } from "./router";

window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root")!;
const router = createRouter();

hydrateRoot(
  root,
  <StrictMode>
    <RouterClient router={router} />
  </StrictMode>,
);
