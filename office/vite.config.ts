import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readFileSync } from "fs";
import type { Plugin } from "vite";

const pkg = JSON.parse(readFileSync("../package.json", "utf-8"));

// Plugin to redirect /office to /office/ (avoid 404 on missing trailing slash)
const trailingSlashRedirect = (): Plugin => ({
  name: 'trailing-slash-redirect',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/office') {
        res.writeHead(301, { Location: '/office/' });
        res.end();
      } else {
        next();
      }
    });
  },
});

export default defineConfig({
  plugins: [tailwindcss(), react(), trailingSlashRedirect()],
  define: {
    __MAW_VERSION__: JSON.stringify(pkg.version),
    __MAW_BUILD__: JSON.stringify(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" })),
  },
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
      "/ws/pty": { target: "ws://white.local:3456", ws: true },
      "/ws": { target: "ws://white.local:3456", ws: true },
    },
  },
});
