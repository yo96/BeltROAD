import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@factorio-eda/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
});
