import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // lets the Lab (or your own additions) hit the demo server without CORS fuss
    proxy: { "/debug": "http://localhost:3001", "/api": "http://localhost:3001" },
  },
});
