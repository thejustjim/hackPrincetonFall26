import { defineConfig } from 'vite';

// In dev, /api and /ws are proxied to the gateway on :8000 (cd gateway && MOCK=1 python gateway.py).
// `npm run build` writes ../web/map with relative paths, so the gateway serves it as static files at /map/.
const GATEWAY = process.env.GATEWAY || 'http://localhost:8000';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': GATEWAY,
      '/ws': { target: GATEWAY.replace(/^http/, 'ws'), ws: true },
    },
  },
  // built into ../web/map, which is committed, so the base station needs no Node and serves it at /map/
  build: { outDir: '../web/map', emptyOutDir: true, chunkSizeWarningLimit: 3000 },
});
