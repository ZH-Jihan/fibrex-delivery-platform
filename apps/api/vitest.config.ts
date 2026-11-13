import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 *   unit         fast, no external services (src/**\/*.test.ts)
 *   integration  real PostgreSQL in a throwaway container (needs Docker), started once by
 *                test/integration/global-setup.ts; files run one at a time because they
 *                share that database.
 */
export default defineConfig({
  test: {
    // The unit project has no files until the kernel arrives (commit 4).
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
