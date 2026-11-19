/**
 * Employee status: the `people.employee` state machine (phase 3 plan section 8: status is a
 * state machine so Phase 4 can drive it with dated history).
 *
 *   createEmployeeStateTarget  how the kernel state service reads an employee and stores
 *                              its new status (registered in src/main.ts);
 *   seedEmployeeStatus         the starting machine for a tenant: active (initial),
 *                              inactive, blocked, terminated, and the moves between them.
 *
 * Why these moves: anyone active can be set inactive, blocked or terminated; inactive and
 * blocked people come back to active or are terminated; a terminated person can be
 * rehired (back to active), so terminated is "closed" but not final, and leaving or
 * rehiring needs a reason. Administrators change all of this on the state machine screen;
 * the seed only adds the machine when the tenant has none, so their edits are never
 * overwritten.
 *
 * Depends on: pg (seed, inside the seed's transaction), kernel/db, kernel/states types,
 * ./employee-router.ts (repository). Used by: ./index.ts, src/main.ts, src/seed/seed.ts.
 */
import type pg from 'pg';
import type { Repository } from '../../kernel/db/repository.js';
import type { StateTarget } from '../../kernel/states/state-service.js';
import { EMPLOYEE_ENTITY, type EmployeeView } from './employee-router.js';

export function createEmployeeStateTarget(repository: Repository<EmployeeView>): StateTarget {
  return {
    load: async (id) => {
      const row = await repository.get(id);
      return {
        id: row.id,
        companyId: row.companyId,
        stateCode: row.statusCode,
        version: row.version,
        fields: {
          sponsorship: row.sponsorship,
          sponsorPartyId: row.sponsorPartyId,
          recruitingAgentPartyId: row.recruitingAgentPartyId,
          joiningDate: row.joiningDate,
          branchId: row.branchId,
          ...(row.customFields as Record<string, unknown>),
        },
        readPermission: 'people.employee.read',
        updatePermission: 'people.employee.status',
      };
    },
    // The repository's versioned update: a stale version is a 409, never a lost change.
    setState: async (subject, toCode) => {
      await repository.update(subject.id, subject.version, { statusCode: toCode });
    },
  };
}

interface SeedState {
  code: string;
  en: string;
  category: 'open' | 'active' | 'closed';
  colour: string;
  isInitial?: boolean;
}

const STATES: readonly SeedState[] = [
  { code: 'active', en: 'Active', category: 'active', colour: '#16a34a', isInitial: true },
  { code: 'inactive', en: 'Inactive', category: 'open', colour: '#ca8a04' },
  { code: 'blocked', en: 'Blocked', category: 'open', colour: '#dc2626' },
  { code: 'terminated', en: 'Terminated', category: 'closed', colour: '#6b7280' },
];

const MOVES: readonly { from: string; to: string; reasonRequired: boolean }[] = [
  { from: 'active', to: 'inactive', reasonRequired: false },
  { from: 'active', to: 'blocked', reasonRequired: true },
  { from: 'active', to: 'terminated', reasonRequired: true },
  { from: 'inactive', to: 'active', reasonRequired: false },
  { from: 'inactive', to: 'terminated', reasonRequired: true },
  { from: 'blocked', to: 'active', reasonRequired: false },
  { from: 'blocked', to: 'terminated', reasonRequired: true },
  { from: 'terminated', to: 'active', reasonRequired: true },
];

/** Adds the employee status machine to a tenant that has none; returns whether it did. */
export async function seedEmployeeStatus(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
): Promise<boolean> {
  const made = await client.query<{ id: string }>(
    `INSERT INTO cfg.state_machine (tenant_id, entity_key, name, description)
     SELECT $1, $2, 'Employee status', 'Where an employee stands: active, inactive, blocked, terminated.'
     WHERE NOT EXISTS (SELECT 1 FROM cfg.state_machine
                       WHERE tenant_id = $1 AND entity_key = $2 AND deleted_at IS NULL)
     RETURNING id`,
    [tenantId, EMPLOYEE_ENTITY],
  );
  const machineId = made.rows[0]?.id;
  if (machineId === undefined) return false;
  for (const [index, state] of STATES.entries()) {
    await client.query(
      `INSERT INTO cfg.state (tenant_id, state_machine_id, code, labels, category, is_initial, colour, sort_order)
       VALUES ($1, $2, $3, jsonb_build_object('en', $4::text), $5, $6, $7, $8)`,
      [
        tenantId,
        machineId,
        state.code,
        state.en,
        state.category,
        state.isInitial === true,
        state.colour,
        index,
      ],
    );
  }
  for (const move of MOVES) {
    await client.query(
      `INSERT INTO cfg.state_transition (tenant_id, state_machine_id, from_code, to_code, reason_required)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, machineId, move.from, move.to, move.reasonRequired],
    );
  }
  return true;
}
