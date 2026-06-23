import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Port is intentionally NOT hardcoded to 5173.
    // Setting port: 0 lets the OS assign an ephemeral port so no two
    // concurrent dev sessions collide and no port assumption leaks into CI.
    port: 0,
    strictPort: false,
  },
  build: {
    // Output to web/dist — kept separate from root dist/
    outDir: "dist",
    emptyOutDir: true,
  },
});
