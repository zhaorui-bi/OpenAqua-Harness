import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'openaqua-harness',
    include: ['test/**/*.test.ts'],
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 44,
        branches: 35,
        functions: 47,
        lines: 47,
      },
    },
  },
});
