import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'shared/**/*.test.ts',
      'koreader/tests/**/*.test.ts',
      'workers/**/*.test.ts',
    ],
    environment: 'node',
    isolate: true,
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/db/**/*.ts', 'shared/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/lib/use*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: { statements: 55, branches: 55, functions: 50, lines: 55 },
    },
  },
})
