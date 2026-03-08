import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  base: "/office/",
  build: {
    outDir: "../dist-office",
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: ["white.local"],
    proxy: {
      "/api": "http://white.local:3456",
      "/ws": { target: "ws://white.local:3456", ws: true },
    },
  },
});
