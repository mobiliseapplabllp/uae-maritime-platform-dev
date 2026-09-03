import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000 }, plugins: [swc.vite({ jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } } })] });
