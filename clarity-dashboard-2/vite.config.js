import { defineConfig } from 'vite';

// In dev, /api and /ws are proxied to the gateway on :8000 (cd gateway && MOCK=1 python gateway.py).
// `npm run build` emits dist/ with relative paths, so the gateway can serve it as static files.
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
  build: { chunkSizeWarningLimit: 3000 },
});
