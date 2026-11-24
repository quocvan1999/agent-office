import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  preview: { host: "127.0.0.1", port: 4173 },
  // Office3D is lazy-loaded, so three.js only downloads when 3D mode is on.
  build: { chunkSizeWarningLimit: 1500 },
});
