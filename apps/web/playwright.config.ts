/**
 * Playwright settings for the main journeys (docs/phases/phase-01-plan.md section 6).
 * The journeys run against the real stack: Docker services up, `pnpm db:migrate`,
 * `pnpm db:seed` and `pnpm db:seed:e2e` done. The API and web dev server are started here
 * unless they already run (reused on a developer machine, started fresh in CI).
 * One worker: the journeys share one demo tenant and sign in as the same two test users.
 * Depends on: @playwright/test. Used by: `pnpm --filter @fibrex/web test:e2e`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @fibrex/api dev',
      url: 'http://localhost:3000/api/v1/companies',
      // 401 means the API is up and refusing an anonymous call, which is all we need.
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      // Fresh start only: the journeys sign in and reload often; a long-running API keeps its own limit.
      env: { AUTH_RATE_LIMIT: '1000' },
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @fibrex/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
