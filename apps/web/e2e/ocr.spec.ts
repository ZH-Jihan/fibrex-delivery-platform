/**
 * Phase 3 journey (row 3.6): scan a document, see the OCR pre-fill, correct it, confirm.
 *
 * Covers the Done-when "OCR pre-fills number and dates with confidence; user confirms
 * before save" in the browser: the admin adds an employee, uploads a synthetic scan with
 * "Scan to fill in", sees the values read (the stub adapter's demo values) with their
 * confidence, changes the expiry date, confirms, and the document appears in the list.
 * Nothing is saved before the confirm.
 *
 * Each run uses its own name suffix (Date.now()) so it can run on a live database.
 */
import { expect, test } from '@playwright/test';
import { ADMIN, signedInAs } from './helpers';

test('admin scans a document, checks the pre-filled values and confirms', async ({ page }) => {
  test.setTimeout(90_000);
  const name = `OCR Journey ${String(Date.now())}`;

  await signedInAs(page, ADMIN);
  await page.goto('/employees');
  await page.getByRole('button', { name: 'New employee' }).click();
  await page.getByLabel('Name (English)').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('link', { name: 'Open profile' }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByText('No documents yet.')).toBeVisible();

  // A synthetic JPEG (start marker plus text): the stub reads demo values from it.
  await page.getByLabel('Scan to fill in').setInputFiles({
    name: 'qid-scan.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(name)]),
  });

  const panel = page.getByRole('region', { name: 'Check the values read from the scan' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Demo reading/)).toBeVisible();
  await expect(panel.getByLabel('Number')).toHaveValue(/^[0-9]{11}$/);
  await expect(panel.getByText(/Read with 93% confidence/)).toBeVisible();
  // Still nothing saved: the list behind the panel is empty.
  await expect(page.getByText('No documents yet.')).toBeVisible();

  const expiry = new Date(Date.now() + 600 * 86_400_000).toISOString().slice(0, 10);
  await panel.getByLabel('Expiry date').fill(expiry);
  await panel.getByRole('button', { name: 'Confirm and save' }).click();

  await expect(page.getByText('Document saved with its scan.')).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.getByText(expiry)).toBeVisible();
});
