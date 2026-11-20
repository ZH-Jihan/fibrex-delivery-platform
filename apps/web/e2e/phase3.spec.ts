/**
 * Phase 3 journeys (row 3.9), one per "Done when" row of docs/phases/phase-03-plan.md section 6
 * that is a browser journey. (The OCR confirm journey is `ocr.spec.ts`; the daily expiry job with
 * a fixed clock and the raw-database ciphertext check are integration tests.)
 *
 *   1. An employee with all 7 standard person documents plus a custom "Gym pass", each with an expiry;
 *      numbers are masked in the list; the soonest expiry shows on the Expiring documents screen.
 *   2. Employee Excel import: 10 rows, 2 bad (shown in the preview), commit 8, undo the import.
 *   3. Two rows of one file with the same QID: the preview names the second row, nothing breaks
 *      at commit.
 *
 * All names, QIDs and phones are invented and unique per run (stamp), so the journeys run on a
 * database that already holds earlier runs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { ADMIN, signedInAs } from './helpers';

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Digits unique to this run and row: 11 for a QID, other lengths for phones. */
const digits = (stamp: number, n: number, length: number): string =>
  `${String(stamp)}${String(n).padStart(2, '0')}`.slice(-length).padStart(length, '1');

async function writeWorkbook(file: string, headers: string[], rows: string[][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.addRow(headers);
  // Every cell is text so Excel does not turn QIDs and phones into numbers.
  for (const row of rows) ws.addRow(row);
  await wb.xlsx.writeFile(file);
}

/** Runs the import wizard from "choose a type" to the preview; returns after step 3 shows. */
async function openPreview(page: Page, file: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'Import and export' }).click();
  await page.getByLabel('Record type').selectOption({ label: 'Employees' });
  await expect(page.getByText('Step 1: choose the file')).toBeVisible();
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.getByText('Step 2: match the columns')).toBeVisible();
  await page.getByRole('button', { name: 'Check the rows' }).click();
  await expect(page.getByText('Step 3: check the rows')).toBeVisible();
}

// Istimara is a vehicle document (offered once vehicles exist, Phase 5), so it is not a choice for a person.
const STANDARD_TYPES = [
  'QID',
  'Driving licence',
  'Passport',
  'Food handling certificate',
  'Health card',
  'Insurance',
  'Agreement',
];

test('employee with all standard documents and a custom one, each with an expiry', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const name = `Docs Journey ${String(stamp)}`;

  await signedInAs(page, ADMIN);
  await page.goto('/employees');
  await page.getByRole('button', { name: 'New employee' }).click();
  await page.getByLabel('Name (English)').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('link', { name: 'Open profile' })
    .click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByText('No documents yet.')).toBeVisible();

  const expiries: string[] = [];
  const numbers: string[] = [];
  for (const [i, typeName] of STANDARD_TYPES.entries()) {
    const expiry = isoDay(200 + i * 30);
    const number = digits(stamp, i, 11);
    expiries.push(expiry);
    numbers.push(number);
    await page.getByRole('button', { name: 'Add document', exact: true }).click();
    await page.getByLabel('Document type').selectOption({ label: typeName });
    // The Agreement type carries no number.
    if (typeName !== 'Agreement') await page.getByLabel('Number').fill(number);
    await page.getByLabel('Expiry date').fill(expiry);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: typeName }).first()).toBeVisible();
  }

  // The custom-named document, soon to expire (it is the one the Expiring screen must show).
  const gymExpiry = isoDay(5);
  await page.getByRole('button', { name: 'Add other document' }).click();
  await page.getByLabel('Name of the document').fill('Gym pass');
  await page.getByLabel('Expiry date').fill(gymExpiry);
  await page.getByRole('button', { name: 'Save' }).click();

  // All 8 documents are listed, each with its expiry date.
  const items = page
    .getByRole('listitem')
    .filter({ hasText: /Expires|[0-9]{4}-[0-9]{2}-[0-9]{2}/ });
  await expect(page.getByRole('listitem').filter({ hasText: 'Gym pass' })).toContainText(gymExpiry);
  for (const [i, typeName] of STANDARD_TYPES.entries()) {
    await expect(page.getByRole('listitem').filter({ hasText: typeName }).first()).toContainText(
      expiries[i] ?? '',
    );
  }
  await expect(items).toHaveCount(8);

  // Identifiers are masked in the list: the full number is never on the page.
  for (const number of numbers) await expect(page.getByText(number)).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'QID' }).first()).toContainText(
    numbers[0]?.slice(-4) ?? '',
  );

  // The soonest expiry is on the Expiring documents screen.
  await page.goto('/documents/expiring');
  await expect(page.getByRole('row', { name: /Gym pass/ }).first()).toBeVisible();
});

test('employee Excel import: preview shows 2 bad rows, commit 8, undo removes them', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const names = Array.from(
    { length: 10 },
    (_, i) => `Import Journey ${String(stamp)} N${String(i)}`,
  );
  const headers = [
    'Full name (English)',
    'QID number',
    'Phones',
    'Sponsorship (company or outside)',
  ];
  const rows = names.map((n, i) => [
    n,
    digits(stamp, 20 + i, 11),
    `+974${digits(stamp, 30 + i, 8)}`,
    'company',
  ]);
  // Row 4: no name. Row 8: a phone that is not a phone.
  rows[3] = ['', digits(stamp, 23, 11), `+974${digits(stamp, 33, 8)}`, 'company'];
  rows[7] = [names[7] ?? '', digits(stamp, 27, 11), '12', 'company'];
  const file = path.join(os.tmpdir(), `employees-${String(stamp)}.xlsx`);
  await writeWorkbook(file, headers, rows);

  try {
    await signedInAs(page, ADMIN);
    await openPreview(page, file);

    await expect(page.getByText('Good rows: 8')).toBeVisible();
    await expect(page.getByText('Rows with problems: 2')).toBeVisible();
    await expect(page.getByRole('row', { name: /^4 .*display_name/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /^8 .*phones/ })).toBeVisible();
    // Nothing is written yet.
    await page.goto('/employees');
    await expect(page.getByRole('row', { name: /Import Journey/ })).toHaveCount(0);

    await openPreview(page, file);
    await page.getByLabel('Import only the good rows and skip the others').check();
    await page.getByRole('button', { name: 'Import now' }).click();
    await expect(page.getByText('Step 4: result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Records created: 8')).toBeVisible();

    // A second browser session (own sign-in) sees the 8 new employees while the wizard stays on step 4.
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const other = await otherContext.newPage();
    await signedInAs(other, ADMIN);
    await other.goto('/employees');
    await other.getByRole('searchbox').fill(`Import Journey ${String(stamp)}`);
    await expect(other.getByRole('row', { name: /Import Journey/ })).toHaveCount(8);

    // Undo the import: the employees are soft-deleted (recycle bin), the person records stay.
    await page.getByLabel('Why undo it?').fill('E2E journey undo');
    await page.getByRole('button', { name: 'Undo this import' }).click();
    await expect(
      page.getByRole('region', { name: 'Import' }).getByText('Import undone'),
    ).toBeVisible({ timeout: 30_000 });
    await other.reload();
    await other.getByRole('searchbox').fill(`Import Journey ${String(stamp)}`);
    await expect(other.getByRole('row', { name: /Import Journey/ })).toHaveCount(0);
    await otherContext.close();
  } finally {
    fs.unlinkSync(file);
  }
});

test('two rows with the same QID: the preview names the second row and the commit succeeds', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const sameQid = digits(stamp, 50, 11);
  const headers = ['Full name (English)', 'QID number'];
  const rows = [
    [`Twin Journey ${String(stamp)} A`, sameQid],
    [`Twin Journey ${String(stamp)} B`, sameQid],
    [`Twin Journey ${String(stamp)} C`, digits(stamp, 51, 11)],
  ];
  const file = path.join(os.tmpdir(), `twins-${String(stamp)}.xlsx`);
  await writeWorkbook(file, headers, rows);
  try {
    await signedInAs(page, ADMIN);
    await openPreview(page, file);
    await expect(page.getByText('Good rows: 2')).toBeVisible();
    await expect(page.getByText('Rows with problems: 1')).toBeVisible();
    await expect(page.getByRole('row', { name: /^2 .*earlier row/ })).toBeVisible();

    await page.getByLabel('Import only the good rows and skip the others').check();
    await page.getByRole('button', { name: 'Import now' }).click();
    await expect(page.getByText('Step 4: result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Records created: 2')).toBeVisible();
    await expect(page.getByText('Imported', { exact: true })).toBeVisible();

    // Clean up so repeated runs stay tidy.
    await page.getByLabel('Why undo it?').fill('E2E journey undo');
    await page.getByRole('button', { name: 'Undo this import' }).click();
    await expect(
      page.getByRole('region', { name: 'Import' }).getByText('Import undone'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    fs.unlinkSync(file);
  }
});
