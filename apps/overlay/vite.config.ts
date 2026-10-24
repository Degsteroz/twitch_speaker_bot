import { defineConfig } from "vite";

// Served behind Caddy under /overlay/, so built asset URLs must carry that prefix.
export default defineConfig({ base: "/overlay/", server: { port: 5174 } });
