import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Note: AgentWorkflow routes progress and completion callbacks back to the
// Agent by class name. Vite does not minify the Worker bundle by default, so
// names survive. If you ever enable minification for the Worker, keep names.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
