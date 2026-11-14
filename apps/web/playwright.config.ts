/**
 * Playwright settings for the main journeys (docs/phases/phase-01-plan.md section 6).
 * The journeys never touch the development database: they start their own API (port 3100) on
 * the separate database `fibrex_e2e`, which `e2e:serve` creates, migrates and seeds, and their
 * own web server (port 5174). Docker services must be up. Servers are never reused, because a
 * reused one could point at the development database.
 * One worker: the journeys share one demo tenant and sign in as the same two test users.
 * Depends on: @playwright/test. Used by: `pnpm --filter @fibrex/web test:e2e`.
 */
import { defineConfig } from '@playwright/test';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5174';
const API_PORT = process.env.E2E_API_PORT ?? '3100';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @fibrex/api e2e:serve',
      // 401 means the API is up and refusing an anonymous call, which is all we need.
      url: `http://localhost:${API_PORT}/api/v1/companies`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      env: { E2E_API_PORT: API_PORT, E2E_WEB_ORIGIN: `http://localhost:${WEB_PORT}` },
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @fibrex/web dev',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { E2E_WEB_PORT: WEB_PORT, E2E_API_PORT: API_PORT },
      timeout: 60_000,
    },
  ],
});
