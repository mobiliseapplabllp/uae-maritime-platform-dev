import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const GATEWAY = process.env.VITE_GATEWAY_URL || 'http://127.0.0.1:5200';

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
