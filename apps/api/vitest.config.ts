import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Relative to whatever `--dir` the script passes, so the unit, integration
    // and security suites can be run independently.
    include: ['**/*.test.ts'],
    // Integration and security suites talk to real services, so they are opt-in
    // via their own scripts rather than part of the default run.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/db/migrate.ts', 'src/db/seed.ts', 'src/db/retention.ts'],
      thresholds: {
        // Focused on the modules that make security decisions rather than on a
        // whole-repo number that would be met by testing mappers.
        lines: 55,
        functions: 55,
      },
    },
  },
});
