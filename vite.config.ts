import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// GhostBus dev server. The Fastify API runs separately (port 8799) and is
// proxied here so the whole app is reachable on one origin during development.
// In production, Fastify serves the built `dist/` itself — one deployable service.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 3499,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8799',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Keep the initial payload lean: the heavy voxel scene is split out and
    // loaded after first paint (see App.tsx lazy import).
    chunkSizeWarningLimit: 700,
  },
});
