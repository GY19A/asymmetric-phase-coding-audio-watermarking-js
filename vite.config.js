import { defineConfig } from 'vite';

// Relative base so dist/ works from any path; dev and preview listen on loopback only.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173, strictPort: false },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 800,
  },
});
