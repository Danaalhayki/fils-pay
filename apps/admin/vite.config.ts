import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    port: 5174,
    // The API sends no CORS headers; the console talks to it same-origin.
    proxy: { "/v1": process.env.API_PROXY_TARGET ?? "http://localhost:3000" },
  },
});
