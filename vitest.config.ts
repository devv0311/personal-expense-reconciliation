import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/**` joined the suite in the 2026-09-19 safety pass. The operational tooling was
    // untested until a teardown script destroyed a database; the classification that decides
    // which stack a port belongs to is now covered like anything else.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Financial arithmetic (allocation, settlement, rounding) will carry a stricter
      // coverage bar once it lands — see docs/testing/testing-strategy.md.
    },
  },
});
