import { defineConfig } from "vite";

// base "./" so the build runs from any path: a Swarm gateway, an ENS gateway, a subfolder.
export default defineConfig({
  base: "./",
  build: { target: "es2022", sourcemap: false, modulePreload: { polyfill: false } },
});
