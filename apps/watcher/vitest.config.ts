import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load .env file before tests run
config();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/database/**/*.test.ts'],
  },
});
