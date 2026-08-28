import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import ssrPlugin from "vite-ssr-components/plugin";
import baseConfig from "../../vite.config.base";

// Rolldown emits `__require("assert")` etc. for CJS deps in Workers ESM.
// nodejs_compat_v2 makes `node:module` createRequire available — inject a
// global `require` shim so CJS wrappers resolve Node builtins correctly.
function workerRequireShim() {
  return {
    name: "worker-require-shim",
    applyToEnvironment(environment: { name: string }) {
      return environment.name !== "client";
    },
    renderChunk(code: string) {
      if (!code.includes("__require")) return null;
      const shim = `import{createRequire as __cr}from"node:module";var require=__cr("file:///worker.mjs");\n`;
      return { code: shim + code, map: null };
    },
  };
}

const config = defineConfig({
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      routeTreeFileHeader: [
        "// biome-ignore-all lint: gen",
        "/* eslint-disable */",
        "// @ts-nocheck",
      ],
      autoCodeSplitting: true,
      routeFileIgnorePattern: ".*/__tests__/.*",
      routesDirectory: resolve(import.meta.dirname, "./src/client/routes"),
      generatedRouteTree: resolve(
        import.meta.dirname,
        "./src/client/routeTree.gen.ts",
      ),
    }),
    cloudflare({ configPath: resolve(import.meta.dirname, "./wrangler.toml") }),
    ssrPlugin({
      hotReload: {
        ignore: ["./src/client/**/*.tsx"],
      },
    }),
    react(),
    workerRequireShim(),
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
});

export default mergeConfig(config, baseConfig);
