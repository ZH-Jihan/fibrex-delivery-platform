/**
 * The workflow journey of row 2.11c, in a real browser with three people (users made by
 * `pnpm db:seed:e2e`): the reviewer, the owner and the manager.
 *
 * Set-up (through the API, as the admin, because building a workflow is not what is tested):
 * a published record type, and a two-step workflow bound to the creation of its records:
 * step 1 "Review" is for the reviewer, step 2 "Manager sign-off" for the role e2e_manager.
 * The admin creates a record, which starts the workflow (so the admin is its starter).
 *
 * Journey:
 *   1. The reviewer sees the task in the task inbox and passes it on to the owner (delegate
 *      from the inbox: no permission is needed to pass on a task that is yours).
 *   2. The owner sees it, approves it.
 *   3. The manager (holding the role) sees step 2, approves it; the workflow ends approved.
 *   4. The reviewer arranges a stand-in on "My stand-ins" (self-service: only the own
 *      delegation keys) and removes it again with a reason.
 * Each run uses its own keys, so the journey can be repeated on the same database.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ADMIN, PASSWORD, signedInAs } from './helpers';

const API = '/api/v1';

async function adminApi(request: APIRequestContext) {
  const login = await request.post(`${API}/auth/login`, {
    data: { tenant: 'demo', identifier: ADMIN, password: PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const token = ((await login.json()) as { accessToken: string }).accessToken;
  const call = async (method: 'get' | 'post', path: string, data?: unknown, version?: number) => {
    const res = await request.fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': `"${String(version)}"` }),
      },
      ...(data === undefined ? {} : { data }),
    });
    expect(res.ok(), `${method} ${path} -> ${String(res.status())}`).toBe(true);
    return (await res.json()) as Record<string, unknown>;
  };
  return call;
}

test('reviewer passes on, owner and manager approve, and a stand-in is arranged', async ({
  page,
  request,
}) => {
  const stamp = String(Date.now());
  const typeKey = `e2ewf${stamp}`;
  const workflowName = `E2E journey ${stamp}`;
  const call = await adminApi(request);

  // Set-up: the people, a published record type, the workflow, its binding, one record.
  const people = (await call('get', '/workflow-people')) as {
    items: { id: string; displayName: string }[];
  };
  const reviewer = people.items.find((p) => p.displayName === 'E2E Reviewer');
  expect(reviewer).toBeDefined();
  const entity = await call('post', '/entity-definitions', { key: typeKey, name: { en: typeKey } });
  await call('post', '/field-definitions', {
    entityDefinitionId: entity.id,
    key: 'seats',
    label: { en: 'Seats' },
    type: 'number',
  });
  const fresh = await call('get', `/entity-definitions/${String(entity.id)}`);
  await call(
    'post',
    `/entity-definitions/${String(entity.id)}/publish`,
    {},
    fresh.version as number,
  );
  const def = await call('post', '/workflow-definitions', {
    key: `e2e_wf_${stamp}`,
    name: workflowName,
    entityKey: typeKey,
  });
  await call('post', '/workflow-versions', {
    workflowDefinitionId: def.id,
    graph: {
      steps: [
        { key: 'review', kind: 'approval', name: 'Review', assignee: { users: [reviewer?.id] } },
        {
          key: 'signoff',
          kind: 'approval',
          name: 'Manager sign-off',
          assignee: { roles: ['e2e_manager'] },
        },
      ],
    },
  });
  await call('post', `/workflow-definitions/${String(def.id)}/versions/publish`, {});
  await call('post', '/workflow-bindings', {
    workflowDefinitionId: def.id,
    trigger: 'on_create',
  });
  const record = await call('post', `/records/${typeKey}`, { data: { seats: 2 } });

  // 1. The reviewer passes the task on to the owner.
  await signedInAs(page, 'e2e.reviewer');
  await page.getByRole('navigation').getByRole('link', { name: 'Task inbox' }).click();
  const reviewTask = page.getByRole('region', { name: `${workflowName} Review` });
  await expect(reviewTask).toBeVisible();
  await reviewTask.getByRole('button', { name: 'Pass on' }).click();
  await page.getByLabel('Pass to').selectOption({ label: 'E2E Owner' });
  await page.getByRole('button', { name: 'Pass task on' }).click();
  await expect(reviewTask).toHaveCount(0);

  // 2. The owner approves it.
  await page.context().clearCookies();
  await signedInAs(page, 'e2e.owner');
  await page.getByRole('navigation').getByRole('link', { name: 'Task inbox' }).click();
  const ownerTask = page.getByRole('region', { name: `${workflowName} Review` });
  await expect(ownerTask).toBeVisible();
  await ownerTask.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(ownerTask).toHaveCount(0);

  // 3. The manager approves step 2; the workflow ends approved.
  await page.context().clearCookies();
  await signedInAs(page, 'e2e.manager');
  await page.getByRole('navigation').getByRole('link', { name: 'Task inbox' }).click();
  const signoff = page.getByRole('region', { name: `${workflowName} Manager sign-off` });
  await expect(signoff).toBeVisible();
  await signoff.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(signoff).toHaveCount(0);
  const done = (await call(
    'get',
    `/workflow-instances?entityType=${typeKey}&entityId=${String(record.id)}`,
  )) as { items: { status: string }[] };
  expect(done.items[0]?.status).toBe('approved');

  // 4. The reviewer arranges a stand-in and removes it again.
  await page.context().clearCookies();
  await signedInAs(page, 'e2e.reviewer');
  await page.getByRole('navigation').getByRole('link', { name: 'My stand-ins' }).click();
  await expect(page.getByRole('heading', { name: 'Stand-ins' })).toBeVisible();
  await page.getByRole('button', { name: 'New stand-in' }).click();
  await page.getByLabel('Stand-in', { exact: true }).selectOption({ label: 'E2E Manager' });
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('From', { exact: true }).fill(today);
  await page.getByLabel('To', { exact: true }).fill(tomorrow);
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('row', { name: /E2E Manager/ });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('journey clean-up');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete|Confirm/ })
    .click();
  await expect(page.getByRole('row', { name: /E2E Manager/ })).toHaveCount(0);

  // A person with only the own-delegation keys has no workflow-builder or bindings entries.
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Workflow bindings' }),
  ).toHaveCount(0);
});
