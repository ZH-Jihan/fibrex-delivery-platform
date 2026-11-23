/**
 * Phase 4 journeys (row 4.10), one per browser-checkable "Done when" row of
 * docs/phases/phase-04-plan.md section 7. (Parser layout cases, the reset guard, retries and
 * alerts, and the hand-calculated report totals are integration tests; here the same screens are
 * driven the way staff use them.)
 *
 *   1. Sync from an uploaded Excel copy: the run is recorded, an upload of the same file again
 *      changes nothing, the Unmatched riders queue holds the IDs nobody owns, and creating an
 *      employee from a queue row links the Falcon ID.
 *   2. Reports: the daily report and the cycle summary show the figures of the fixture (the
 *      numbers are worked out here from the fixture's own rule, not read from the screen).
 *   3. Morning call sheet: figures of the previous day, a day off is marked, a status change needs
 *      a reason and shows on the employee's Tracking tab, a call is logged, an overlapping
 *      operator period is refused.
 *
 * The sheet is the fake fixture of the API tests (invented names and IDs, unique per run through a
 * stamp), written to an .xlsx file and uploaded as "downloaded on 2026-11-20", so the dates in the
 * checks do not depend on today's date. The source is an upload-only Excel source, so Google is
 * never contacted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  FAKE_PEOPLE,
  fakeFigures,
  snoonuWorkbook,
  type FakePerson,
} from '../../api/test/fixtures/snoonu-daily-report';
import { ADMIN, signedInAs } from './helpers';

/** The day the fake Excel copy was "downloaded": the cycle is 26 Oct to 25 Nov 2026. */
const READ_ON = '2026-11-20';
/** The sheet is one day behind, so on the 20th the newest figures are the 19th's. */
const FIGURES_DAY = 19;
/** Cycle days with figures in the fixture: 26 to 31 October, then 1 to 19 November. */
const CYCLE_DATES: { date: string; day: number }[] = [
  ...[26, 27, 28, 29, 30, 31].map((day) => ({ date: `2026-10-${String(day)}`, day })),
  ...Array.from({ length: 19 }, (_, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    day: i + 1,
  })),
];

const stamp = Date.now();
/** IDs divisible by 9 plus 0..3, so none of them has a blank day on the 19th (see fakeFigures). */
const BASE_ID = 9 * (1_000_000 + (stamp % 800_000));
const people: FakePerson[] = FAKE_PEOPLE.map((p, i) => ({
  ...p,
  falconId: BASE_ID + i,
  name: `E2E ${p.name.replace('Test ', '')} ${String(stamp)}`,
  phone: Number(`974${String(stamp).slice(-7)}${String(i)}`),
}));
const [alpha, bravo, charlie, delta] = people as [FakePerson, FakePerson, FakePerson, FakePerson];
const SOURCE = `E2E Snoonu upload ${String(stamp)}`;

let workbookFile = '';
test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibrex-phase4-'));
  workbookFile = path.join(dir, 'daily-report.xlsx');
  fs.writeFileSync(workbookFile, await snoonuWorkbook({ people }));
});

const money = (n: number): string => String(n);

async function uploadDay(page: Page): Promise<void> {
  await page.goto('/performance/sync-runs');
  await page.getByLabel('Source', { exact: true }).selectOption({ label: SOURCE });
  await page.getByRole('button', { name: "Upload a day's Excel" }).click();
  await page.getByLabel('Downloaded on').fill(READ_ON);
  await page.getByLabel('Excel file').setInputFiles(workbookFile);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/queued/i).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('upload a day from Excel, run twice, and turn unmatched IDs into employees', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signedInAs(page, ADMIN);

  // An Excel source belongs to the Snoonu platform (seeded) and is only ever uploaded to.
  await page.goto('/performance/sync-sources');
  await page.getByRole('button', { name: 'Add source' }).click();
  await page.getByLabel('Platform').selectOption({ label: 'Snoonu' });
  await page.getByLabel('Name', { exact: true }).fill(SOURCE);
  await page.getByLabel('Kind').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(SOURCE)).toBeVisible();

  await uploadDay(page);
  const firstRun = page.getByRole('row').filter({ hasText: SOURCE }).first();
  await expect(firstRun).toContainText('Succeeded', { timeout: 60_000 });
  // 4 people read, none known yet (the queue below holds them).
  await expect(firstRun.getByRole('cell').nth(5)).toHaveText('4');
  await expect(firstRun.getByRole('cell').nth(7)).toHaveText('4');

  // The same file again: a second run is logged and nothing doubles (matched stays as before).
  await uploadDay(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('row').filter({ hasText: SOURCE })).toHaveCount(2, {
    timeout: 60_000,
  });

  // The queue holds our four IDs; make employees of three, ignore the fourth.
  await page.goto('/performance/unmatched');
  const search = page.getByLabel('Search by Falcon ID, name or phone');
  for (const p of [alpha, bravo, delta]) {
    const row = page.getByRole('row').filter({ hasText: String(p.falconId) });
    // The list reloads after each save and can reset the box once, so type until the row shows.
    await expect(async () => {
      await search.fill(String(p.falconId));
      await expect(row).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Create employee' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create employee' }).click();
    await expect(row).toHaveCount(0);
  }
  await search.fill(String(charlie.falconId));
  const rowC = page.getByRole('row').filter({ hasText: String(charlie.falconId) });
  await rowC.getByRole('button', { name: 'Ignore' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Another company (journey)');
  await page.getByRole('button', { name: 'Ignore ID' }).click();
  await expect(page.getByText('Ignored.')).toBeVisible();
});

test('daily report and cycle summary show the fixture figures', async ({ page }) => {
  test.setTimeout(120_000);
  await signedInAs(page, ADMIN);

  const day = fakeFigures(alpha, FIGURES_DAY);
  if (day === null) throw new Error('fixture: Alpha has no figures on the 19th');
  await page.goto('/performance/reports/daily');
  await page.getByLabel('Day').fill('2026-11-19');
  const alphaRow = page.getByRole('row').filter({ hasText: alpha.name });
  await expect(alphaRow).toContainText(money(day.delivered));

  await page.goto('/performance/reports/cycle');
  await page.getByRole('button', { name: 'Date range' }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-10-26');
  await page.getByLabel('To', { exact: true }).fill('2026-11-25');
  const total = CYCLE_DATES.reduce(
    (sum, d) => sum + (fakeFigures(alpha, d.day)?.delivered ?? 0),
    0,
  );
  const daysWorked = CYCLE_DATES.filter((d) => fakeFigures(alpha, d.day) !== null).length;
  const cycleRow = page.getByRole('row').filter({ hasText: alpha.name });
  await expect(cycleRow).toContainText(money(total));
  await expect(cycleRow).toContainText(money(daysWorked));
});

test('call sheet: day off, status change with a reason, a call, operator periods', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signedInAs(page, ADMIN);

  await page.goto('/tracking');
  await page.getByLabel('Date', { exact: true }).fill(READ_ON);
  await page.getByLabel('Search name, code, ID or phone').fill(String(stamp));
  await expect(page.getByText(/Figures are from 2026-11-19/)).toBeVisible();

  const alphaRow = page.getByRole('row').filter({ hasText: alpha.name });
  const deltaRow = page.getByRole('row').filter({ hasText: delta.name });
  await expect(alphaRow).toContainText(String(fakeFigures(alpha, FIGURES_DAY)?.delivered));
  // Delta's day off is Friday and 2026-11-20 is a Friday.
  await expect(deltaRow).toContainText('Day off');

  // A call is logged and the row says so.
  await alphaRow.getByRole('button', { name: 'Log a call' }).click();
  await page.getByLabel('Outcome').selectOption({ index: 1 });
  await page.getByLabel('Note').fill('Journey call');
  await page.getByRole('button', { name: 'Save call' }).click();
  await expect(page.getByText('Call saved.')).toBeVisible();
  // Status: "Inactive" needs a reason (the Save button stays off until one is chosen); a second
  // change back to "Active" needs none. The profile history then lists both rows.
  const setStatus = async (code: string, reason: boolean) => {
    await alphaRow.getByRole('button', { name: 'Set status' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('New status').selectOption(code);
    const save = dialog.getByRole('button', { name: 'Save status' });
    if (reason) {
      await expect(save).toBeDisabled();
      await dialog.getByLabel(/^Reason/).selectOption({ index: 1 });
    }
    // A status cannot take effect before the person's last change (the employee was made today).
    await dialog.getByLabel('Effective date').fill(new Date().toISOString().slice(0, 10));
    await dialog.getByLabel('Note').fill(`Journey ${code}`);
    // The sheet reloads after a save; the next change must start from the reloaded row.
    const reloaded = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/tracking'),
    );
    await save.click();
    await reloaded;
    await expect(dialog).toHaveCount(0);
  };
  await setStatus('inactive', true);
  await setStatus('active', false);

  // The employee's Tracking tab keeps both the call and the status change (history).
  await alphaRow.getByRole('link', { name: 'Open profile' }).click();
  await page.getByRole('tab', { name: 'Tracking' }).click();
  await expect(page.getByText('Journey call')).toBeVisible();
  await expect(page.getByText('Journey inactive')).toBeVisible();
  await expect(page.getByText('Journey active')).toBeVisible();

  // Operator period: saved, then an overlapping one is refused.
  const addPeriod = async (from: string, to: string, operator: string) => {
    await page.getByRole('button', { name: 'Add period' }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('From', { exact: true }).fill(from);
    await form.getByLabel(/^To/).fill(to);
    await form.getByLabel('Operator name').fill(operator);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
  };
  await addPeriod('2026-11-01', '2026-11-10', 'Journey operator one');
  await expect(page.getByText('Journey operator one')).toBeVisible();
  await addPeriod('2026-11-05', '2026-11-15', 'Journey operator two');
  // Overlap is refused: the dialog stays open and the second operator is not listed.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Journey operator two')).toHaveCount(0);
});

test('Phase 4 screens fit a phone (375 px) without sideways scrolling', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await signedInAs(page, ADMIN);
  const screens: [string, string][] = [
    ['/tracking', 'Morning call sheet'],
    ['/performance/sync-runs', 'Sync runs'],
    ['/performance/unmatched', 'Unmatched riders'],
    ['/performance/reports/daily', 'Daily performance'],
    ['/performance/fdb-check', 'FDB'],
  ];
  for (const [url, heading] of screens) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(heading) })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${url} scrolls sideways by ${String(overflow)} px`).toBeLessThanOrEqual(1);
  }
});
