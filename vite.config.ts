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
  // maplibre-gl ships a web worker the Vite dep optimizer can't pre-bundle
  // (it 404s the worker in dev). Excluding it lets Vite serve it as an ESM
  // module worker; production build is unaffected. See DECISIONS §23.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  // maplibre-gl v6 builds its worker with `new Worker(url, { type: 'module' })`,
  // so the chunk we hand it via `?worker&url` (MapCard.tsx) must be ESM — the
  // Vite default of 'iife' would be loaded as a module and blow up. See DECISIONS §29.
  worker: {
    format: 'es',
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
    chunkSizeWarningLimit: 700,
  },
});
