/**
 * People module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: the employee master database (SPEC 3.2) on top of the party model. Row 3.1:
 * employees, employment periods and placements. Row 3.2: document types, requirements and
 * documents (sealed numbers, renewals, scans through the files module). Expiry alerts, OCR
 * and import follow in rows 3.4 to 3.8. An employee is a party with the `employee` role; other
 * modules reference the `party_id`.
 *
 * `createPeopleModule` returns the module manifest (routes, permissions, recycle-bin types,
 * custom fields, attachable employee, menu entry) and the employee state target, which
 * src/main.ts registers with the kernel state service.
 *
 * Depends on: ./employee-router.ts, ./placement-router.ts, ./employee-status.ts,
 * ./document-type-router.ts, ./document-router.ts, modules/party (PartyService, PartyVault),
 * modules/files (AttachableRegistry), kernel/audit, kernel/module-registry, kernel/permissions,
 * kernel/numbering, kernel/states. Used by: src/main.ts, src/seed/seed.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { RecycleBinType } from '../../kernel/audit/recycle-bin.js';
import type { BaseRow, Repository } from '../../kernel/db/repository.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import type { NumberingService } from '../../kernel/numbering/numbering-service.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { StateService, StateTarget } from '../../kernel/states/state-service.js';
import type { AttachableRegistry } from '../files/index.js';
import type { PartyService, PartyVault } from '../party/index.js';
import {
  DOCUMENT_ENTITY,
  createDocumentRepository,
  createDocumentRouter,
} from './document-router.js';
import {
  createDocumentTypeRepository,
  createDocumentTypeRouter,
  createRequirementRepository,
} from './document-type-router.js';
import {
  EMPLOYEE_ENTITY,
  createEmployeeRepository,
  createEmployeeRouter,
} from './employee-router.js';
import { createEmployeeStateTarget } from './employee-status.js';
import {
  createPeriodRepository,
  createPlacementRepository,
  createPlacementRouter,
} from './placement-router.js';

export { EMPLOYEE_ENTITY } from './employee-router.js';
export { seedEmployeeStatus } from './employee-status.js';
export { DOCUMENT_ENTITY } from './document-router.js';
export { seedDocumentTypes } from './document-type-router.js';

export const PEOPLE_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('people', 'people.employee', 'employees'),
  permission('people', 'people.employee', 'status', 'Change an employee status'),
  ...crudPermissions('people', 'people.placement', 'employee placements'),
  ...crudPermissions('people', 'people.employment_period', 'employment periods'),
  ...crudPermissions('people', 'people.document_type', 'document types'),
  ...crudPermissions('people', 'people.document_requirement', 'document requirements'),
  ...crudPermissions('people', 'people.document', 'documents'),
  permission(
    'people',
    'people.document_number',
    'reveal',
    'Show the full number of a document (audited)',
  ),
];

export interface PeopleModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  parties: PartyService;
  numbering: NumberingService;
  /** Seals document numbers (the party identifier vault, phase 3 decision "no new crypto"). */
  vault: PartyVault;
  audit: AuditService;
  /** Filled by main.ts from every manifest; read lazily when a document file is added. */
  attachables: AttachableRegistry;
  states?: Pick<StateService, 'initialCode' | 'recordStart'>;
  onCreated?: (entityType: string, id: string) => Promise<void>;
}

export interface PeopleModule {
  manifest: ModuleManifest;
  /** Register with the kernel `StateTargets` under `EMPLOYEE_ENTITY`. */
  employeeStateTarget: StateTarget;
}

export function createPeopleModule(deps: PeopleModuleDeps): PeopleModule {
  const { uow, registry, permissions } = deps;
  const employees = createEmployeeRepository(deps);
  const placements = createPlacementRepository();
  const periods = createPeriodRepository();
  const documentTypes = createDocumentTypeRepository();
  const requirements = createRequirementRepository();
  const documents = createDocumentRepository({ parties: deps.parties, vault: deps.vault });

  // One recycle-bin entry; the cast only widens the row type, the repository is unchanged.
  const recycle = <TRow extends BaseRow>(
    entityType: string,
    label: string,
    repository: Repository<TRow>,
    describe: (row: TRow) => string,
  ): RecycleBinType =>
    ({ entityType, moduleKey: 'people', label, repository, describe }) as unknown as RecycleBinType;

  const manifest: ModuleManifest = {
    key: 'people',
    label: 'People and documents',
    permissions: PEOPLE_PERMISSIONS,
    routers: [
      createEmployeeRouter({ ...deps, uow, registry, permissions, repository: employees }),
      createPlacementRouter({ uow, registry, permissions, placements, periods }),
      createDocumentTypeRouter({
        uow,
        registry,
        permissions,
        types: documentTypes,
        requirements,
      }),
      createDocumentRouter({
        uow,
        registry,
        permissions,
        audit: deps.audit,
        vault: deps.vault,
        attachables: deps.attachables,
        repository: documents,
      }),
    ],
    nav: [
      {
        path: '/employees',
        labelKey: 'nav.employees',
        groupKey: 'nav.people.group',
        permission: 'people.employee.read',
      },
    ],
    recycleTypes: [
      recycle('people.employee', 'Employee', employees, (r) =>
        `${r.employeeCode} ${r.displayName ?? ''}`.trim(),
      ),
      recycle('people.employee_placement', 'Employee placement', placements, (r) => r.profession),
      recycle('people.employment_period', 'Employment period', periods, (r) =>
        r.startDate.toISOString().slice(0, 10),
      ),
      recycle('people.document_type', 'Document type', documentTypes, (r) => r.code),
      recycle(
        'people.document_requirement',
        'Document requirement',
        requirements,
        (r) => r.documentTypeId,
      ),
      recycle(DOCUMENT_ENTITY, 'Document', documents, (r) =>
        `${r.customName ?? 'document'} ${r.numberMasked ?? ''}`.trim(),
      ),
    ],
    // Administrators may add custom fields to employees (SPEC 3.2 "custom fields").
    entities: [{ key: EMPLOYEE_ENTITY, name: { en: 'Employees' } }],
    attachables: [
      {
        entityType: EMPLOYEE_ENTITY,
        readPermission: 'people.employee.read',
        attachPermission: 'people.employee.update',
        exists: async (db, id) =>
          (await db.employee.findFirst({ where: { id }, select: { id: true } })) !== null,
      },
      {
        entityType: DOCUMENT_ENTITY,
        readPermission: 'people.document.read',
        attachPermission: 'people.document.update',
        exists: async (db, id) =>
          (await db.document.findFirst({ where: { id }, select: { id: true } })) !== null,
      },
    ],
  };
  return { manifest, employeeStateTarget: createEmployeeStateTarget(employees) };
}
