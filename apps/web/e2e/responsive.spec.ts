/**
 * Responsive layout check: opens Users, Roles, Permission matrix and Branches at phone
 * (375 px), tablet (768 px) and desktop (1280 px) widths, fails if the page can scroll
 * sideways, and saves a full-page screenshot of each to e2e/screenshots/ (git-ignored) for a
 * quick visual review. On the phone it also opens the drawer once to show the menu.
 * Runs against the same stack as journeys.spec.ts (see playwright.config.ts).
 */
import { expect, test } from '@playwright/test';
import { ADMIN, signedInAs } from './helpers';

const SCREENS = [
  { name: 'Users', path: '/users', slug: 'users' },
  { name: 'Roles', path: '/roles', slug: 'roles' },
  { name: 'Permission matrix', path: '/permission-matrix', slug: 'permission-matrix' },
  { name: 'Branches', path: '/organisation/branches', slug: 'branches' },
] as const;

const WIDTHS = [375, 768, 1280] as const;

for (const width of WIDTHS) {
  test(`no horizontal page scroll at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    await signedInAs(page, ADMIN);

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1, name: screen.name })).toBeVisible();
      // Wait until nothing is loading, so the screenshot shows real rows.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

      const size = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      expect(
        size.scrollWidth,
        `${screen.name} overflows at ${String(width)}px`,
      ).toBeLessThanOrEqual(size.clientWidth);
      expect(
        size.bodyWidth,
        `${screen.name} body overflows at ${String(width)}px`,
      ).toBeLessThanOrEqual(size.clientWidth);
      await page.screenshot({
        path: `e2e/screenshots/${screen.slug}-${String(width)}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }

    if (width < 768) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
      await page.screenshot({
        path: `e2e/screenshots/drawer-${String(width)}.png`,
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Menu' })).toHaveCount(0);
    }
  });
}
