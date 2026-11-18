/**
 * Ledger balances API (phase 2 row 2.16b; PLAN 5.11).
 *
 *   GET /ledger/balances?account=&party=&dims=&asOf=
 *
 * Sub-ledger query: the balance (debit minus credit, base currency) of each account over the
 * posted lines that match the account, party, dimensions and date. `dims` is
 * `name:id,name:id` with name one of the ledger dimensions (party, employee, vehicle,
 * client_platform, branch, cost_centre, pay_period, loan). Needs `gl.journal.read`. Reads only; no balance is stored.
 *
 * Depends on: express, zod, kernel/db, kernel/http, kernel/permissions, ./ledger-queries.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { balancesByAccount } from './ledger-queries.js';

const query = z.object({
  account: z.uuid().optional(),
  party: z.uuid().optional(),
  dims: z.string().max(600).optional(),
  asOf: z.iso.date().optional(),
});
const money = z.string();
const result = z
  .object({
    asOf: z.string().nullable(),
    items: z.array(
      z.object({
        accountId: z.uuid(),
        accountCode: z.string(),
        accountName: z.string(),
        baseDebit: money,
        baseCredit: money,
        balance: money,
      }),
    ),
    totals: z.object({ baseDebit: money, baseCredit: money, balance: money }),
  })
  .meta({ id: 'LedgerBalances' });

export interface LedgerRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createLedgerRouter(deps: LedgerRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();

  router.get('/ledger/balances', async (req, res) => {
    const q = query.parse(req.query);
    const items = await uow.run(async () => {
      await permissions.require('gl.journal.read');
      return balancesByAccount(currentUnit().db, {
        accountId: q.account,
        partyId: q.party,
        dims: q.dims,
        asOf: q.asOf,
      });
    });
    let debit = new Prisma.Decimal(0);
    let credit = new Prisma.Decimal(0);
    for (const row of items) {
      debit = debit.plus(row.baseDebit);
      credit = credit.plus(row.baseCredit);
    }
    res.json({
      asOf: q.asOf ?? null,
      items,
      totals: {
        baseDebit: debit.toFixed(4),
        baseCredit: credit.toFixed(4),
        balance: debit.minus(credit).toFixed(4),
      },
    });
  });

  registerRoute(registry, {
    method: 'get',
    path: '/ledger/balances',
    tags: ['Ledger'],
    summary: 'Balance per account by account, party, dimensions and date (base currency)',
    request: { query },
    responses: {
      200: { description: 'Balances', content: { 'application/json': { schema: result } } },
      400: {
        description: 'Bad dimension filter',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
      403: {
        description: 'Missing permission',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    },
  });

  return router;
}
