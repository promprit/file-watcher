import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import path from 'path';

// Load .env file before tests run
config();

export default defineConfig({
  resolve: {
    alias: {
      '@packages/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@packages/testing': path.resolve(__dirname, '../../packages/testing/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    // Run tests sequentially to avoid database conflicts in integration tests
    fileParallelism: false,
  },
});
