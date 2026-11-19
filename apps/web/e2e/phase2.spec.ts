/**
 * Phase 2 journey (row 2.19): end-to-end coverage for every Done-when in phase-02-plan.md
 * section 6 that is not already covered by workflow.spec.ts, journeys.spec.ts, or the API
 * integration suite.
 *
 * This spec covers:
 *   - Custom record type builder: create a type with 5 fields, publish it.
 *   - Records CRUD: create, open detail, edit, delete with reason.
 *   - Recycle bin: restore a deleted custom record.
 *   - Data exchange: import 3 rows from CSV, export.
 *
 * Set-up: the admin creates the type and all records through the UI; no API short-cuts.
 * Each run uses its own key suffix (Date.now()) so it can run on a live database.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN, signedInAs } from './helpers';

test('admin builds a record type, works with records, imports and exports', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = String(Date.now());
  const typeKey = `e2evi${stamp}`;
  const typeName = `Vehicle inspection ${stamp}`;

  // ------------------------------------------------------------------ //
  // 1. Build the record type with 5 fields                              //
  // ------------------------------------------------------------------ //
  await signedInAs(page, ADMIN);
  await page.getByRole('navigation').getByRole('link', { name: 'Record types' }).click();
  await page.getByRole('button', { name: 'New record type' }).click();
  await page.getByLabel('Key').fill(typeKey);
  await page.getByLabel('Name (English)').fill(typeName);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: new RegExp(typeKey) })).toHaveCount(1);

  // Open the fields panel for this type.
  await page
    .getByRole('row', { name: new RegExp(typeKey) })
    .getByRole('button', { name: 'Fields' })
    .click();
  const fieldsPanel = page.getByRole('region', { name: new RegExp('Fields of') });
  await expect(fieldsPanel).toBeVisible();

  const addField = async (key: string, label: string, type: string) => {
    await fieldsPanel.getByRole('button', { name: 'New field' }).click();
    await page.getByLabel('Key').fill(key);
    await page.getByLabel('Name (English)').fill(label);
    await page.getByLabel('Type').selectOption(type);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(fieldsPanel.getByRole('row', { name: new RegExp(key) })).toHaveCount(1);
  };

  await addField('plate_no', 'Plate No', 'text');
  await addField('year', 'Year', 'number');
  await addField('mileage', 'Mileage', 'decimal');
  await addField('inspection_date', 'Inspection Date', 'date');
  await addField('passed', 'Passed', 'boolean');

  // Publish the type.
  await page
    .getByRole('row', { name: new RegExp(typeKey) })
    .getByRole('button', { name: 'Publish' })
    .click();
  // After publishing the Publish button disappears (no unpublished changes).
  await expect(
    page
      .getByRole('row', { name: new RegExp(typeKey) })
      .getByRole('button', { name: 'Publish' }),
  ).toHaveCount(0);

  // ------------------------------------------------------------------ //
  // 2. Navigate to the Records screen for this type                     //
  // ------------------------------------------------------------------ //
  await page.getByRole('navigation').getByRole('link', { name: 'Records' }).click();
  await page.getByRole('link', { name: new RegExp(typeName) }).click();

  // ------------------------------------------------------------------ //
  // 3. Create a record                                                  //
  // ------------------------------------------------------------------ //
  await page.getByRole('button', { name: new RegExp('New') }).click();
  await page.getByLabel('Plate No').fill('ABC-001');
  await page.getByLabel('Year').fill('2023');
  await page.getByLabel('Mileage').fill('45000');
  await page.getByLabel('Inspection Date').fill('2026-06-15');
  // The boolean field is a checkbox; click its label to toggle it on.
  await page.getByLabel('Passed').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /ABC-001/ })).toHaveCount(1);

  // ------------------------------------------------------------------ //
  // 4. Open detail view                                                 //
  // ------------------------------------------------------------------ //
  await page.getByRole('row', { name: /ABC-001/ }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('region', { name: 'Record details' })).toBeVisible();
  await page.getByRole('region', { name: 'Record details' }).getByRole('button', { name: 'Back' }).click();

  // ------------------------------------------------------------------ //
  // 5. Edit the record                                                  //
  // ------------------------------------------------------------------ //
  await page.getByRole('row', { name: /ABC-001/ }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Mileage').fill('46500');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /ABC-001/ })).toHaveCount(1);

  // ------------------------------------------------------------------ //
  // 6. Delete with reason                                               //
  // ------------------------------------------------------------------ //
  await page.getByRole('row', { name: /ABC-001/ }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('phase 2 e2e journey clean-up');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete|Confirm/ })
    .click();
  await expect(page.getByRole('row', { name: /ABC-001/ })).toHaveCount(0);

  // ------------------------------------------------------------------ //
  // 7. Restore from recycle bin                                         //
  // ------------------------------------------------------------------ //
  await page.getByRole('navigation').getByRole('link', { name: 'Recycle bin' }).click();
  await page.getByLabel('Record type').selectOption('cfg.custom_record');
  const deleted = page.getByRole('row', { name: /ABC-001/ });
  await expect(deleted).toHaveCount(1);
  await deleted.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('row', { name: /ABC-001/ })).toHaveCount(0);

  // ------------------------------------------------------------------ //
  // 8. Import 3 rows via Data Exchange                                  //
  // ------------------------------------------------------------------ //
  const csvContent = [
    'Plate No,Year,Mileage,Inspection Date,Passed',
    'XY-100,2022,67000,2026-01-10,true',
    'XY-200,2021,98000,2026-02-05,false',
    'XY-300,2024,8500,2026-03-20,true',
  ].join('\n');
  const csvPath = path.join(os.tmpdir(), `phase2-import-${stamp}.csv`);
  fs.writeFileSync(csvPath, csvContent, 'utf8');

  await page.getByRole('navigation').getByRole('link', { name: 'Import and export' }).click();
  await page.getByLabel('Record type').selectOption(typeKey);

  // Step 1: choose the file.
  await expect(page.getByText('Step 1: choose the file')).toBeVisible();
  await page.locator('#import-file').setInputFiles(csvPath);

  // Step 2: match the columns (auto-mapped).
  await expect(page.getByText('Step 2: match the columns')).toBeVisible();
  await page.getByRole('button', { name: 'Check the rows' }).click();

  // Step 3: preview.
  await expect(page.getByText('Step 3: check the rows')).toBeVisible();
  await page.getByRole('button', { name: 'Import now' }).click();

  // Step 4: result.
  await expect(page.getByText('Step 4: result')).toBeVisible();

  // Clean up temp file.
  fs.unlinkSync(csvPath);

  // ------------------------------------------------------------------ //
  // 9. Export                                                           //
  // ------------------------------------------------------------------ //
  await page.getByRole('tab', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Export and download' })).toBeVisible();
  await page.getByRole('button', { name: 'Export and download' }).click();
  // The export is queued; wait for a row to appear in the recent exports list.
  await expect(page.getByRole('cell', { name: new RegExp(typeKey) })).toHaveCount(1, {
    timeout: 15_000,
  });
});
