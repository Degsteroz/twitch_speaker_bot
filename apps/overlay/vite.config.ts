import { defineConfig } from "vite";

// One id per build: the page carries it in its code and serves it as version.json. OBS keeps the
// page open for the whole stream, so after a release the page compares the two and reloads itself.
const BUILD_ID = process.env.OVERLAY_BUILD_ID ?? Date.now().toString(36);

// Served behind Caddy under /overlay/, so built asset URLs must carry that prefix.
export default defineConfig({
  base: "/overlay/",
  server: { port: 5174 },
  define: { __OVERLAY_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [
    {
      name: "overlay-build-id",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ build: BUILD_ID })
        });
      }
    }
  ]
});
