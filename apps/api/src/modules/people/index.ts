/**
 * People module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: the employee master database (SPEC 3.2) on top of the party model. Row 3.1:
 * employees, employment periods and placements. Row 3.2: document types, requirements and
 * documents (sealed numbers, renewals, scans through the files module). Row 3.4: the expiry
 * engine (daily job, alert settings, expiring list and calendar). Row 3.6: OCR of scans
 * (pre-fill, then a person confirms; mounted when src/main.ts passes an OCR adapter and the
 * object store). Row 3.7: bulk scan upload (many scans, a suggested person and type each, staff confirm). Row 3.8: employee Excel import (a target on the generic import wizard). An employee is a party with the `employee` role; other
 * modules reference the `party_id`.
 *
 * `createPeopleModule` returns the module manifest (routes, permissions, recycle-bin types,
 * custom fields, attachable employee, menu entry, event types), the employee state target,
 * which src/main.ts registers with the kernel state service, and the expiry service, whose
 * `run` src/main.ts schedules daily.
 *
 * Depends on: ./employee-router.ts, ./placement-router.ts, ./employee-status.ts,
 * ./document-type-router.ts, ./document-router.ts, ./expiry-service.ts, ./expiry-router.ts,
 * ./expiry-seed.ts, ./ocr-router.ts, adapters/ocr, adapters/storage, modules/party (PartyService, PartyVault),
 * modules/files (AttachableRegistry), kernel/audit, kernel/module-registry, kernel/permissions,
 * kernel/numbering, kernel/states. Used by: src/main.ts, src/seed/seed.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { OcrAdapter } from '../../adapters/ocr/interface.js';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
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
import { createEmployeeDirectory, type EmployeeDirectory } from './employee-directory.js';
import { createEmployeeImportTarget } from './employee-import.js';
import type { ImportTarget } from '../../kernel/imports/import-targets.js';
import { createExpiryRouter } from './expiry-router.js';
import { EXPIRY_EVENT, ExpiryService, type ExpiryJobDeps } from './expiry-service.js';
import { createBulkUploadRouter } from './bulk-upload-router.js';
import { createOcrEngine } from './ocr-router.js';
import { PEOPLE_REPORTS } from './people-reports.js';
import {
  createPeriodRepository,
  createPlacementRepository,
  createPlacementRouter,
} from './placement-router.js';

export { EMPLOYEE_ENTITY } from './employee-router.js';
export type {
  CreatedEmployee,
  EmployeeCandidate,
  EmployeeDirectory,
  NewEmployeeFromSheet,
} from './employee-directory.js';
export { seedEmployeeStatus } from './employee-status.js';
export { DOCUMENT_ENTITY } from './document-router.js';
export { seedDocumentTypes } from './document-type-router.js';
export {
  EXPIRY_EVENT,
  ExpiryService,
  consolidatedEmail,
  type ExpiryItem,
  type ExpiryJobDeps,
  type ExpiryRunResult,
} from './expiry-service.js';
export { seedExpiryAlerts, OWNER_EXPIRY_EMAILS, EXPIRY_RULE_NAME } from './expiry-seed.js';

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
  permission('people', 'people.expiry_settings', 'read', 'See the document expiry alert settings'),
  permission(
    'people',
    'people.expiry_settings',
    'update',
    'Change the expiry email list and alert windows',
  ),
  permission('people', 'people.ocr_job', 'create', 'Read a scan with OCR to pre-fill a document'),
  permission('people', 'people.ocr_job', 'read', 'See OCR readings of scans'),
  ...crudPermissions('people', 'people.bulk_upload', 'bulk scan uploads'),
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
  states?: Pick<StateService, 'initialCode' | 'recordStart' | 'transition'>;
  onCreated?: (entityType: string, id: string) => Promise<void>;
  /** The daily expiry job (src/main.ts); without it the expiry lists still work. */
  expiryJob?: ExpiryJobDeps;
  /** Row 3.6: the OCR adapter and the object store holding the scans; both or neither. */
  ocr?: { adapter: OcrAdapter; storage: StorageAdapter };
  /** Row 3.8: where the employee import target is registered (the kernel `ImportTargets`). */
  importTargets?: { register(target: ImportTarget): void };
  /** Fixed clock for the expiry engine and OCR (tests). */
  now?: () => Date;
}

export interface PeopleModule {
  manifest: ModuleManifest;
  /** Register with the kernel `StateTargets` under `EMPLOYEE_ENTITY`. */
  employeeStateTarget: StateTarget;
  /** Schedule `expiry.run()` daily (src/main.ts). */
  expiry: ExpiryService;
  /** Service interface for other modules (row 4.5b: the unmatched riders queue). */
  directory: EmployeeDirectory;
}

export function createPeopleModule(deps: PeopleModuleDeps): PeopleModule {
  const { uow, registry, permissions } = deps;
  const employees = createEmployeeRepository(deps);
  const placements = createPlacementRepository();
  const periods = createPeriodRepository();
  // Row 3.8: employees become importable on the generic wizard (Excel, preview, rollback).
  deps.importTargets?.register(
    createEmployeeImportTarget({
      parties: deps.parties,
      repository: employees,
      vault: deps.vault,
      ...(deps.states === undefined ? {} : { states: deps.states }),
    }),
  );
  const documentTypes = createDocumentTypeRepository();
  const requirements = createRequirementRepository();
  const documents = createDocumentRepository({ parties: deps.parties, vault: deps.vault });
  // Rows 3.6 and 3.7 share one OCR engine, so a bulk confirm is the same path as a single one.
  const ocrEngine =
    deps.ocr === undefined
      ? undefined
      : createOcrEngine({
          uow,
          registry,
          permissions,
          parties: deps.parties,
          vault: deps.vault,
          attachables: deps.attachables,
          documents,
          storage: deps.ocr.storage,
          ocr: deps.ocr.adapter,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
  const expiry = new ExpiryService({
    uow,
    parties: deps.parties,
    ...(deps.expiryJob === undefined ? {} : { job: deps.expiryJob }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

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
      // Before the documents CRUD router: /documents/expiring is not a document id.
      createExpiryRouter({ uow, registry, permissions, expiry }),
      ...(ocrEngine === undefined
        ? []
        : [
            ocrEngine.router,
            createBulkUploadRouter({ uow, registry, permissions, ocr: ocrEngine }),
          ]),
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
      {
        path: '/documents/expiring',
        labelKey: 'nav.expiring',
        groupKey: 'nav.people.group',
        permission: 'people.document.read',
      },
      ...(ocrEngine === undefined
        ? []
        : [
            {
              path: '/documents/bulk',
              labelKey: 'nav.bulkUpload',
              groupKey: 'nav.people.group',
              permission: 'people.bulk_upload.read',
            },
          ]),
      {
        path: '/documents/expiry-settings',
        labelKey: 'nav.expirySettings',
        groupKey: 'nav.people.group',
        permission: 'people.expiry_settings.read',
      },
    ],
    reports: PEOPLE_REPORTS,
    eventTypes: [
      {
        key: EXPIRY_EVENT,
        moduleKey: 'people',
        label: 'Documents expiring',
        description:
          'Daily: documents reached an alert window or expired. Payload: date, expiringCount, expiredCount, expiring[], expired[].',
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
  return {
    manifest,
    employeeStateTarget: createEmployeeStateTarget(employees),
    expiry,
    directory: createEmployeeDirectory(employees),
  };
}
