import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/server/index.ts',
        'src/jira/cli.ts',
        'src/jira/check.ts',
        'src/jira/resolve-cli.ts',
        'src/ai/check.ts',
        'src/ai/eval.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
