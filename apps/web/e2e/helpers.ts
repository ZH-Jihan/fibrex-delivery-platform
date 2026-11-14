/**
 * Shared helpers for the journeys: sign in as one of the two synthetic test users created by
 * `pnpm db:seed:e2e` (password from E2E_PASSWORD, default shown in apps/api/src/seed/e2e-seed.ts).
 * Used by: e2e/*.spec.ts.
 */
import { expect, type Page } from '@playwright/test';

export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-Synthetic-Pass-2026';
export const ADMIN = 'e2e.admin';
export const VIEWER = 'e2e.viewer';

export async function signIn(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Organisation code').fill('demo');
  await page.getByLabel('Username or e-mail').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function signedInAs(page: Page, username: string): Promise<void> {
  await signIn(page, username);
  await expect(page.getByRole('navigation')).toBeVisible();
}
