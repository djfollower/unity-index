import { defineConfig } from 'vitest/config';

// Mirrors graph/core/vitest.config.ts. Node environment is fine — Day 3's
// only test target is the pure snapshotToGraph adapter; no DOM, no Sigma.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
