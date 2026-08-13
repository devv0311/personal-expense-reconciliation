import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Financial arithmetic (allocation, settlement, rounding) will carry a stricter
      // coverage bar once it lands — see docs/testing/testing-strategy.md.
    },
  },
});
