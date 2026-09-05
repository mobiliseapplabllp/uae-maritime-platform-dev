import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GATEWAY = process.env.VITE_GATEWAY_URL || 'http://127.0.0.1:5200';
const SRC = fileURLToPath(new URL('./src', import.meta.url));

/* Every deep icon import the app makes, pre-bundled at start-up. Left to discovery, the first visit to a page with an
 * icon the dev server has not met yet makes it re-optimise and reload the page mid-flow: a drive loses its step and a
 * person loses an unsaved form. */
function iconImports(dir: string, out = new Set<string>()): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) iconImports(path, out);
    else if (/\.tsx?$/.test(name)) for (const m of readFileSync(path, 'utf8').matchAll(/from '(@mui\/icons-material\/[A-Za-z0-9]+)'/g)) out.add(m[1]);
  }
  return [...out].sort();
}

export default defineConfig({
  plugins: [react()],
  // @maritime/contracts builds to CommonJS for the Node services, and a bundler cannot see
  // named exports through its re-export helpers. The browser build reads the TypeScript source
  // directly, so the app always compiles against current contracts and never a stale dist.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@maritime/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: { include: iconImports(SRC) },
  server: { port: 5300, host: '127.0.0.1', proxy: { '/api': { target: GATEWAY, changeOrigin: true } } },
  preview: { port: 5300, proxy: { '/api': { target: GATEWAY, changeOrigin: true } } },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { manualChunks: { mui: ['@mui/material', '@mui/icons-material'], charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom', '@reduxjs/toolkit', 'react-redux', 'axios', 'dayjs'] } } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
