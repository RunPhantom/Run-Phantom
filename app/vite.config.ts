import react from "@vitejs/plugin-react-swc";
import { readFileSync } from "node:fs";
import path from "path";
import { defineConfig } from "vite";

const uiPort = Number(process.env.RUNPHANTOM_UI_PORT ?? "5948");
const backendPort = Number(process.env.RUNPHANTOM_PORT ?? "5947");
const backendUrl = `http://localhost:${backendPort}`;
const rootPackage = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version?: string };
const appVersion = process.env.RUNPHANTOM_VERSION || rootPackage.version || "dev";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["lucide-react"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: uiPort,
    proxy: {
      "/api": backendUrl,
      "/v1": backendUrl,
      "/ws": { target: backendUrl.replace(/^http/, "ws"), ws: true },
    },
  },
});
