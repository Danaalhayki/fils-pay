import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API sends no CORS headers; the dashboard talks to it same-origin.
    proxy: { "/v1": process.env.API_PROXY_TARGET ?? "http://localhost:3000" },
  },
});
