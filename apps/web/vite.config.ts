import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Absolute site URL for canonical and Open Graph tags in index.html (%VITE_SITE_URL%).
// Self-hosted installs on another domain pass their own at build time.
process.env.VITE_SITE_URL = (process.env.VITE_SITE_URL ?? "https://roast.recursia.online").replace(
  /\/$/u,
  ""
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", rewrite: (path) => path.replace(/^\/api/u, "") }
    }
  }
});
