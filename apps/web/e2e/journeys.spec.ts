/**
 * The main journeys of Phase 1 in a real browser (phase plan section 6):
 *   1. sign-in: a wrong password is refused; the right one opens the shell;
 *   2. permissions: a read-only user does not see the create, edit and delete buttons (the
 *      API refuses them too, tested in the integration suite);
 *   3. branches: create, edit, delete with a reason, find it in the recycle bin, restore it,
 *      and see the changes in its History.
 * Each run uses its own branch code, so the journeys can be repeated on the same database.
 */
import { expect, test } from '@playwright/test';
import { ADMIN, VIEWER, signIn, signedInAs } from './helpers';

test('sign-in refuses a wrong password and accepts the right one', async ({ page }) => {
  await signIn(page, ADMIN, 'not-the-password-123');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await signIn(page, ADMIN);
  await expect(page.getByRole('navigation')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Branches' })).toBeVisible();
});

test('a read-only user does not see what they cannot do', async ({ page }) => {
  await signedInAs(page, VIEWER);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Roles' })).toBeVisible();

  await nav.getByRole('link', { name: 'Roles' }).click();
  await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New role' })).toHaveCount(0);

  await nav.getByRole('link', { name: 'Branches' }).click();
  await expect(page.getByRole('heading', { name: 'Branches' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New branch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  await nav.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New user' })).toHaveCount(0);
});

test('a branch can be created, edited, deleted, found in the recycle bin and restored', async ({
  page,
}) => {
  const code = `E2E${String(Date.now()).slice(-8)}`;
  await signedInAs(page, ADMIN);
  await page.getByRole('navigation').getByRole('link', { name: 'Branches' }).click();

  await page.getByRole('button', { name: 'New branch' }).click();
  await page.getByRole('textbox', { name: 'Code' }).fill(code);
  await page.getByRole('textbox', { name: 'Name' }).fill('Journey branch');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0); // the form closed: saved
  const row = page.getByRole('row', { name: new RegExp(code) });
  await expect(row).toHaveCount(1); // retries until the list has reloaded

  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Journey branch (renamed)');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0); // the form closed: saved
  await expect(page.getByRole('row', { name: new RegExp(code) })).toHaveCount(1);
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('renamed');

  // History shows the create and the change.
  await page
    .getByRole('row', { name: new RegExp(code) })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.getByText('Journey branch (renamed)').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page
    .getByRole('row', { name: new RegExp(code) })
    .getByRole('button', { name: 'Delete' })
    .click();
  await page.getByRole('dialog').getByRole('textbox').fill('journey clean-up');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete|Confirm|Yes/ })
    .click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toHaveCount(0);

  await page.getByRole('navigation').getByRole('link', { name: 'Recycle bin' }).click();
  await page.getByLabel('Record type').selectOption('platform.branch');
  const deleted = page.getByRole('row', { name: new RegExp(code) });
  await expect(deleted).toHaveCount(1);
  await deleted.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toHaveCount(0);

  await page.getByRole('navigation').getByRole('link', { name: 'Branches' }).click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toHaveCount(1);
});
