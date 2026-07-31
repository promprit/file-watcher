import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@packages/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@packages/testing': path.resolve(__dirname, '../../packages/testing/src/index.ts'),
    },
  },
});
