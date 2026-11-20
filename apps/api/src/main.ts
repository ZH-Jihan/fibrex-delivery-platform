/**
 * API server entry point.
 *
 * Purpose: load configuration, connect to PostgreSQL and Redis, build the Express app and
 * listen. On SIGTERM/SIGINT it stops accepting connections, lets in-flight requests finish
 * (up to 10 seconds), then closes the database pool and Redis, so deploys do not cut
 * requests off (SPEC 6.6 zero-downtime rollout).
 *
 * Local development reads the repository-root .env (an existing variable is never
 * overwritten). Run with `pnpm --filter @fibrex/api dev`.
 *
 * Depends on: src/app.ts, kernel/config, kernel/db/pool.ts, kernel/redis/client.ts,
 * kernel/observability/logger.ts. Used by: the `dev` and `start` scripts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MessagingAdapter } from './adapters/messaging/interface.js';
import { SmtpMessagingAdapter } from './adapters/messaging/smtp.js';
import { StubMessagingAdapter } from './adapters/messaging/stub.js';
import { API_PREFIX, createApp } from './app.js';
import { createAuditRouter } from './kernel/audit/audit-router.js';
import { createAuditService } from './kernel/audit/audit-service.js';
import { RecycleBin } from './kernel/audit/recycle-bin.js';
import {
  createBranchRepository,
  createOrganisationRouter,
} from './kernel/platform/organisation-router.js';
import { AccessTokens } from './kernel/auth/access-token.js';
import {
  createApiClientRepository,
  createApiClientRouter,
} from './kernel/auth/api-client-router.js';
import { ApiKeyResolver } from './kernel/auth/api-keys.js';
import { createAuthRouter } from './kernel/auth/auth-router.js';
import { AuthService } from './kernel/auth/auth-service.js';
import { authenticate } from './kernel/auth/authenticate.js';
import { createImpersonationRouter } from './kernel/auth/impersonation.js';
import { MfaFactors } from './kernel/auth/mfa.js';
import { createUserAdminRouter, createUserRepository } from './kernel/auth/user-admin-router.js';
import { ConfigError, loadEnv } from './kernel/config/env.js';
import { SecretBox } from './kernel/crypto/secret-box.js';
import { createPool } from './kernel/db/pool.js';
import { createPrisma } from './kernel/db/prisma.js';
import { currentUnit, UnitOfWork } from './kernel/db/unit-of-work.js';
import {
  createEntityDefinitionRepository,
  createEntityDefinitionRouter,
  createFieldDefinitionRepository,
} from './kernel/entities/entity-definition-router.js';
import { EntityDefinitionService } from './kernel/entities/entity-definition-service.js';
import {
  createLookupRouter,
  createLookupTypeRepository,
  createLookupValueRepository,
} from './kernel/lookups/lookup-router.js';
import { LookupService } from './kernel/lookups/lookup-service.js';
import {
  createTemplateRepository,
  createTemplateRouter,
  createTemplateVersionRepository,
} from './kernel/templates/template-router.js';
import {
  createFormulaRepository,
  createFormulaRouter,
  createFormulaVersionRepository,
} from './kernel/formulas/formula-router.js';
import { FormulaService } from './kernel/formulas/formula-service.js';
import {
  createRateRouter,
  createRateRowRepository,
  createRateTableRepository,
} from './kernel/rates/rate-router.js';
import { RateService } from './kernel/rates/rate-service.js';
import {
  createStateMachineRepository,
  createStateRepository,
  createStateRouter,
  createStateTransitionRepository,
} from './kernel/states/state-router.js';
import { StateService, StateTargets } from './kernel/states/state-service.js';
import {
  createWorkflowBindingRepository,
  createWorkflowDefinitionRepository,
  createWorkflowDelegationRepository,
  createWorkflowRouter,
} from './kernel/workflows/workflow-router.js';
import { WORKFLOW_EVENT_TYPES, WorkflowService } from './kernel/workflows/workflow-service.js';
import { ModuleRegistry, createModuleRouter } from './kernel/module-registry/index.js';
import {
  createEventRouter,
  createWebhookSubscriptionRepository,
} from './kernel/events/event-router.js';
import { EventOutbox } from './kernel/events/outbox.js';
import { OutboxRelay } from './kernel/events/relay.js';
import { WebhookDispatcher } from './kernel/events/webhooks.js';
import {
  createNumberSequenceRepository,
  createNumberingRouter,
} from './kernel/numbering/numbering-router.js';
import { NumberingService } from './kernel/numbering/numbering-service.js';
import { ExportService } from './kernel/imports/export-service.js';
import { ImportQueue } from './kernel/imports/import-queue.js';
import {
  createImportMappingRepository,
  createImportRouter,
} from './kernel/imports/import-router.js';
import { ImportService } from './kernel/imports/import-service.js';
import { customRecordTarget, ImportTargets } from './kernel/imports/import-targets.js';
import { createRecordRouter } from './kernel/records/record-router.js';
import { FILE_ENTITY_TYPE, RecordService } from './kernel/records/record-service.js';
import { createLogger } from './kernel/observability/logger.js';
import { createAccessAdminRouter } from './kernel/permissions/access-admin-router.js';
import { AccessAdminService } from './kernel/permissions/access-admin-service.js';
import { KERNEL_PERMISSIONS, syncPermissionCatalogue } from './kernel/permissions/catalogue.js';
import {
  createRetentionPolicyRepository,
  createRetentionRouter,
} from './kernel/retention/retention-router.js';
import { RetentionService, RetentionTargets } from './kernel/retention/retention-service.js';
import { KERNEL_REPORTS } from './kernel/reports/kernel-reports.js';
import { createReportRouter } from './kernel/reports/report-router.js';
import { ReportService } from './kernel/reports/report-service.js';
import { syncReportDefinitions } from './kernel/reports/report-sync.js';
import { PermissionService } from './kernel/permissions/permission-service.js';
import { createJobRouter, JOB_PERMISSIONS } from './kernel/jobs/job-router.js';
import { JobScheduler } from './kernel/jobs/scheduler.js';
import { sealAuditLog } from './kernel/audit/sealing-job.js';
import { createRedis } from './kernel/redis/client.js';
import { S3StorageAdapter } from './adapters/storage/s3.js';
import { ChromiumPdfRenderer } from './adapters/pdf/chromium.js';
import { StubOcrAdapter } from './adapters/ocr/stub.js';
import { PdfQueue } from './kernel/templates/pdf-queue.js';
import { AttachableRegistry, FilesService, createFilesModule } from './modules/files/index.js';
import {
  EmailQueue,
  NotifyService,
  RealtimeGateway,
  createNotifyConsumer,
  createNotifyModule,
  syncEventTypes,
  type NotificationView,
} from './modules/notify/index.js';
import { BankVault, createGlModule } from './modules/gl/index.js';
import {
  PartyReferenceRegistry,
  PartyService,
  PartyVault,
  createPartyModule,
} from './modules/party/index.js';
import { EMPLOYEE_ENTITY, createPeopleModule } from './modules/people/index.js';
import { createPerformanceModule } from './modules/performance/index.js';
import { createTrackingModule } from './modules/tracking/index.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../.env');
if (process.env.DATABASE_URL === undefined && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    serviceName: env.OTEL_SERVICE_NAME,
  });
  const pool = createPool(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const prisma = createPrisma(pool);
  const uow = new UnitOfWork(prisma);
  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const mfa = new MfaFactors({
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    tokenSecret: env.AUTH_TOKEN_SECRET,
    issuer: env.AUTH_TOTP_ISSUER,
  });
  // STUB: sign-in codes and reset links are written to the log, not sent (never their
  // text in production). Replaced by real SMS and email providers later (PROGRESS.md).
  const stubMessaging = new StubMessagingAdapter({
    logger,
    revealText: env.NODE_ENV !== 'production',
  });
  // Email goes through SMTP when SMTP_HOST is set (Mailpit locally); SMS stays on the stub.
  const messaging: MessagingAdapter =
    env.SMTP_HOST === undefined
      ? stubMessaging
      : new SmtpMessagingAdapter({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          ...(env.SMTP_USER === undefined ? {} : { user: env.SMTP_USER }),
          ...(env.SMTP_PASSWORD === undefined ? {} : { password: env.SMTP_PASSWORD }),
          from: env.SMTP_FROM,
          sms: stubMessaging,
        });
  const auth = new AuthService({ prisma, uow, redis, tokens, mfa, messaging, logger, env });
  const permissions = new PermissionService(uow);
  const admin = new AccessAdminService({ permissions });
  const recycleBin = new RecycleBin();
  recycleBin.register({
    entityType: 'iam.user_account',
    moduleKey: 'iam',
    label: 'User',
    repository: createUserRepository({ permissions, admin }),
    describe: (user) => `${user.username} (${user.displayName})`,
  });
  recycleBin.register({
    entityType: 'iam.role',
    moduleKey: 'iam',
    label: 'Role',
    repository: admin.roleRepository(),
    describe: (role) => role.name,
  });
  recycleBin.register({
    entityType: 'platform.branch',
    moduleKey: 'platform',
    label: 'Branch',
    repository: createBranchRepository(),
    describe: (branch) => `${branch.code} (${branch.name})`,
  });
  recycleBin.register({
    entityType: 'platform.number_sequence',
    moduleKey: 'platform',
    label: 'Numbering sequence',
    repository: createNumberSequenceRepository(),
    describe: (sequence) => `${sequence.key} (${sequence.format})`,
  });
  recycleBin.register({
    entityType: 'platform.lookup_type',
    moduleKey: 'platform',
    label: 'Lookup list',
    repository: createLookupTypeRepository(),
    describe: (type) => `${type.key} (${type.name})`,
  });
  recycleBin.register({
    entityType: 'platform.lookup_value',
    moduleKey: 'platform',
    label: 'Lookup value',
    repository: createLookupValueRepository(),
    describe: (value) => value.code,
  });
  recycleBin.register({
    entityType: 'platform.template',
    moduleKey: 'platform',
    label: 'Template',
    repository: createTemplateRepository(),
    describe: (template) => `${template.key} (${template.name})`,
  });
  recycleBin.register({
    entityType: 'platform.template_version',
    moduleKey: 'platform',
    label: 'Template version',
    repository: createTemplateVersionRepository(),
    describe: (version) => `${version.language} v${String(version.versionNo)}`,
  });
  recycleBin.register({
    entityType: 'platform.formula',
    moduleKey: 'platform',
    label: 'Formula',
    repository: createFormulaRepository(),
    describe: (formula) => `${formula.key} (${formula.name})`,
  });
  recycleBin.register({
    entityType: 'platform.formula_version',
    moduleKey: 'platform',
    label: 'Formula version',
    repository: createFormulaVersionRepository(),
    describe: (version) => `v${String(version.versionNo)}`,
  });
  recycleBin.register({
    entityType: 'platform.rate_table',
    moduleKey: 'platform',
    label: 'Rate table',
    repository: createRateTableRepository(),
    describe: (table) => `${table.key} (${table.name})`,
  });
  recycleBin.register({
    entityType: 'platform.rate_table_row',
    moduleKey: 'platform',
    label: 'Rate',
    repository: createRateRowRepository(),
    describe: (row) =>
      `${row.value.toFixed(4)} ${row.currency} from ${row.validFrom.toISOString().slice(0, 10)}`,
  });
  recycleBin.register({
    entityType: 'iam.api_client',
    moduleKey: 'iam',
    label: 'API client',
    repository: createApiClientRepository({ permissions }),
    describe: (client) => client.name,
  });
  if (
    env.S3_BUCKET === undefined ||
    env.S3_ACCESS_KEY === undefined ||
    env.S3_SECRET_KEY === undefined
  ) {
    throw new Error(
      'Object storage is not configured: set S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY',
    );
  }
  const storage = new S3StorageAdapter({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  const audit = createAuditService();
  const attachables = new AttachableRegistry();
  const files = new FilesService({
    storage,
    permissions,
    audit,
    attachables,
    tokenSecret: env.AUTH_TOKEN_SECRET,
    maxBytes: env.FILES_MAX_BYTES,
    uploadTtlSeconds: env.FILES_UPLOAD_TTL_SECONDS,
    downloadTtlSeconds: env.FILES_DOWNLOAD_TTL_SECONDS,
  });
  // Columns in other modules that hold a party id and must follow a party merge.
  const partyReferences = new PartyReferenceRegistry();
  partyReferences.register({
    schema: 'iam',
    table: 'user_account',
    column: 'party_id',
    label: 'Login accounts',
  });
  partyReferences.register({
    schema: 'files',
    table: 'file_attachment',
    column: 'entity_id',
    label: 'Attached files',
    where: "entity_type = 'party.party'",
  });
  // People (phase 3): the employee, its outside sponsor and its recruiting agent are parties.
  for (const [column, label] of [
    ['party_id', 'Employee record'],
    ['sponsor_party_id', 'Employees sponsored'],
    ['recruiting_agent_party_id', 'Employees recruited'],
  ] as const) {
    partyReferences.register({ schema: 'people', table: 'employee', column, label });
  }
  const apiKeys = new ApiKeyResolver({ prisma, uow, redis, logger });
  // Business modules register a manifest (SPEC 2.13); the kernel's own permission keys are
  // given so the registry can check every menu entry and attachable points at a real key.
  const modules = new ModuleRegistry({
    kernelPermissions: [...KERNEL_PERMISSIONS, ...JOB_PERMISSIONS],
  });

  // Notifications: the realtime gateway needs the HTTP server, which exists only after
  // listen(), so the service pushes through a holder that is filled in below.
  const realtimeHolder: { gateway?: RealtimeGateway } = {};
  const emailQueue = new EmailQueue({ redisUrl: env.REDIS_URL, uow, messaging, logger });
  const pdfRenderer = new ChromiumPdfRenderer({ executablePath: env.PDF_CHROMIUM_PATH });
  const pdfQueue = new PdfQueue({
    redisUrl: env.REDIS_URL,
    uow,
    storage,
    renderer: pdfRenderer,
    logger,
  });
  const notify = new NotifyService({
    uow,
    logger,
    email: emailQueue,
    realtime: {
      notify: (tenantId: string, userId: string, notification: NotificationView) => {
        realtimeHolder.gateway?.notify(tenantId, userId, notification);
      },
    },
  });
  // Event outbox (row 2.12): services write events in their own transaction; the relay
  // hands them to the notification rules and to webhooks after the commit (a nudge per
  // commit, plus a recurring run that catches anything left over).
  const outbox = new EventOutbox();
  const relay = new OutboxRelay({ prisma, uow, redisUrl: env.REDIS_URL, logger });
  const webhooks = new WebhookDispatcher({
    uow,
    redisUrl: env.REDIS_URL,
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    logger,
    // http and internal hosts only outside production (local receivers, tests).
    allowInsecure: env.NODE_ENV !== 'production',
  });
  relay.register(createNotifyConsumer(notify));
  relay.register(webhooks.consumer());
  outbox.onCommitted(() => {
    relay.nudge();
  });
  recycleBin.register({
    entityType: 'integration.webhook_subscription',
    moduleKey: 'integration',
    label: 'Webhook subscription',
    repository: createWebhookSubscriptionRepository(),
    describe: (sub) => `${sub.name} (${sub.url})`,
  });

  // Recurring background jobs (SPEC 2.12): audit sealing and monthly partition creation.
  const scheduler = new JobScheduler(env.REDIS_URL, logger);
  scheduler.register({
    name: 'outbox-relay',
    everyMs: 5_000,
    run: async () => {
      await relay.publishPending();
    },
  });
  scheduler.register({
    name: 'audit-seal',
    everyMs: 60_000,
    run: async () => {
      await sealAuditLog(prisma);
    },
  });
  scheduler.register({
    name: 'partition-maintenance',
    everyMs: 24 * 60 * 60_000,
    run: async () => {
      await prisma.$executeRaw`SELECT app.maintain_partitions()`;
    },
  });

  // Entity builder (row 2.4). The built-in record types come from the module manifests,
  // read when a request needs them, by which time every module is registered.
  const lookups = new LookupService();
  const entities = new EntityDefinitionService({
    lookups,
    systemEntities: () => modules.entities(),
  });
  recycleBin.register({
    entityType: 'platform.entity_definition',
    moduleKey: 'platform',
    label: 'Record type',
    repository: createEntityDefinitionRepository(entities),
    describe: (entity) => entity.key,
  });
  recycleBin.register({
    entityType: 'platform.field_definition',
    moduleKey: 'platform',
    label: 'Field of a record type',
    repository: createFieldDefinitionRepository(),
    describe: (field) => field.key,
  });

  // Custom records (row 2.5). A field or a link may point at a record of a module (a party,
  // a file): the owning module answers whether it exists, through what its manifest declares
  // as attachable, so the kernel never reads a module's tables. Read per request, by which
  // time every module is registered.
  const numbering = new NumberingService();
  // State machines (row 2.10). Every custom record type can change state through its
  // record service; a module registers its own entity types on `stateTargets`. The arrow
  // function reads `records` only when a request arrives, after it is built below.
  const stateTargets: StateTargets = new StateTargets((key) => records.stateTarget(key));
  // Workflows (row 2.11a) start from a record's creation or a move; the arrows read
  // `workflows`, built just below, only when a request arrives.
  const states: StateService = new StateService({
    permissions,
    targets: stateTargets,
    onTransition: (move) => workflows.onTransition(move),
  });
  const rates = new RateService();
  const formulas = new FormulaService(rates);
  const workflows: WorkflowService = new WorkflowService({
    permissions,
    targets: stateTargets,
    states,
    evaluate: (key, onDate, inputs) => formulas.evaluate(key, onDate, inputs),
    events: {
      record: (e) =>
        outbox.record({
          eventType: e.eventType,
          companyId: e.companyId,
          aggregateType: 'platform.workflow_instance',
          aggregateId: e.instanceId,
          payload: e.payload,
        }),
    },
    logger,
  });
  recycleBin.register({
    entityType: 'platform.workflow_definition',
    moduleKey: 'platform',
    label: 'Workflow',
    repository: createWorkflowDefinitionRepository(),
    describe: (definition) => `${definition.key} (${definition.name})`,
  });
  recycleBin.register({
    entityType: 'platform.workflow_binding',
    moduleKey: 'platform',
    label: 'Workflow binding',
    repository: createWorkflowBindingRepository(workflows),
    describe: (binding) => `${binding.entityKey} ${binding.trigger}`,
  });
  recycleBin.register({
    entityType: 'platform.workflow_delegation',
    moduleKey: 'platform',
    label: 'Workflow delegation',
    repository: createWorkflowDelegationRepository(),
    describe: (d) =>
      `${d.validFrom.toISOString().slice(0, 10)} to ${d.validTo.toISOString().slice(0, 10)}`,
  });
  // Retention: counts what each active policy would affect, once a day. Always a dry run:
  // `allowLive` is never passed here and no module registers a target yet (DECISIONS 2.18).
  const retention = new RetentionService({ targets: new RetentionTargets(), logger });
  scheduler.register({
    name: 'retention-dry-run',
    everyMs: 24 * 60 * 60_000,
    run: async () => {
      await retention.sweep(prisma, uow);
    },
  });
  recycleBin.register({
    entityType: 'platform.retention_policy',
    moduleKey: 'platform',
    label: 'Retention policy',
    repository: createRetentionPolicyRepository(retention),
    describe: (policy) => `${policy.entityKey} (${String(policy.keepMonths)} months)`,
  });
  scheduler.register({
    name: 'workflow-sla',
    everyMs: 5 * 60_000,
    run: async () => {
      await workflows.sweep(prisma, uow);
    },
  });
  recycleBin.register({
    entityType: 'platform.state_machine',
    moduleKey: 'platform',
    label: 'State machine',
    repository: createStateMachineRepository(),
    describe: (machine) => `${machine.entityKey} (${machine.name})`,
  });
  recycleBin.register({
    entityType: 'platform.state',
    moduleKey: 'platform',
    label: 'State',
    repository: createStateRepository(),
    describe: (state) => state.code,
  });
  recycleBin.register({
    entityType: 'platform.state_transition',
    moduleKey: 'platform',
    label: 'State transition',
    repository: createStateTransitionRepository(),
    describe: (transition) => `${transition.fromCode} -> ${transition.toCode}`,
  });
  const records: RecordService = new RecordService({
    entities,
    numbering,
    states,
    onCreated: (key, id) => workflows.onCreated(key, id),
    referenceExists: async (entityType, id) => {
      if (entityType === FILE_ENTITY_TYPE) return files.exists(id);
      const owner = modules.attachables().find((a) => a.entityType === entityType);
      return owner?.exists(currentUnit().db, id);
    },
  });
  recycleBin.register({
    entityType: 'cfg.custom_record',
    moduleKey: 'custom',
    label: 'Custom record',
    repository: records.binRepository(),
    describe: (record) => record.number ?? record.id,
  });

  // Generic import (row 2.8a): every published custom record type is importable; a module
  // that wants its own table importable registers a target here.
  const importTargets = new ImportTargets((key) => customRecordTarget({ records, entities }, key));
  const importService = new ImportService({ uow, storage, permissions, targets: importTargets });
  const exportService = new ExportService({ storage, permissions, targets: importTargets });
  // Reports (row 2.13): kernel reports plus every module manifest's `reports`.
  const reportService = new ReportService({
    permissions,
    storage,
    renderer: pdfRenderer,
    definitions: () => [...KERNEL_REPORTS, ...modules.reports()],
  });
  const importQueue = new ImportQueue({ redisUrl: env.REDIS_URL, service: importService, logger });
  recycleBin.register({
    entityType: 'integration.import_mapping',
    moduleKey: 'integration',
    label: 'Import mapping',
    repository: createImportMappingRepository(),
    describe: (mapping) => `${mapping.name} (${mapping.entityKey})`,
  });

  const app = createApp({
    env,
    logger,
    redis,
    authenticate: authenticate({ tokens, redis, apiKeys }),
    mountApi: (api, registry) => {
      api.use(
        createAuthRouter({
          auth,
          registry,
          redis,
          logger,
          env,
          cookiePath: `${API_PREFIX}/auth`,
        }),
      );
      api.use(createUserAdminRouter({ uow, registry, permissions, admin, auth }));
      api.use(createAccessAdminRouter({ uow, registry, permissions, admin, auth }));
      api.use(createImpersonationRouter({ uow, registry, permissions, admin, auth, tokens, env }));
      api.use(createApiClientRouter({ uow, registry, permissions, auth }));
      api.use(createOrganisationRouter({ uow, registry, permissions }));
      api.use(createNumberingRouter({ uow, registry, permissions, numbering }));
      api.use(createLookupRouter({ uow, registry, permissions, lookups }));
      api.use(createTemplateRouter({ uow, registry, permissions }));
      api.use(createFormulaRouter({ uow, registry, permissions, formulas }));
      api.use(createRateRouter({ uow, registry, permissions, rates }));
      api.use(createEntityDefinitionRouter({ uow, registry, permissions, entities }));
      api.use(createRecordRouter({ uow, registry, permissions, records }));
      api.use(createStateRouter({ uow, registry, permissions, states }));
      api.use(createWorkflowRouter({ uow, registry, permissions, workflows }));
      api.use(createRetentionRouter({ uow, registry, permissions, retention }));
      api.use(
        createImportRouter({
          uow,
          registry,
          permissions,
          service: importService,
          exports: exportService,
          queue: importQueue,
          targets: importTargets,
        }),
      );
      // Module manifests. A new module is one more `modules.register(...)` line here.
      const partyVault = new PartyVault(
        new SecretBox(env.DATA_ENCRYPTION_KEY),
        env.DATA_ENCRYPTION_KEY,
      );
      modules.register(
        createPartyModule({
          uow,
          registry,
          permissions,
          audit,
          vault: partyVault,
          references: partyReferences,
        }),
      );
      // People (phase 3): employees on top of parties; the status is a kernel state machine.
      const people = createPeopleModule({
        uow,
        registry,
        permissions,
        parties: new PartyService(partyVault),
        numbering,
        vault: partyVault,
        audit,
        attachables,
        importTargets,
        states,
        onCreated: (key, id) => workflows.onCreated(key, id),
        expiryJob: { prisma, messaging, outbox, logger },
        // STUB OCR (demo values) until the owner chooses a provider: an adapter swap only.
        ocr: { adapter: new StubOcrAdapter(), storage },
      });
      stateTargets.register(EMPLOYEE_ENTITY, people.employeeStateTarget);
      // Document expiry (row 3.4): daily; safe to run twice (the alert log is the guard).
      scheduler.register({
        name: 'document-expiry',
        everyMs: 24 * 60 * 60_000,
        run: async () => {
          await people.expiry.run();
        },
      });
      modules.register(people.manifest);
      modules.register(createFilesModule({ uow, registry, permissions, files, attachables }));
      modules.register(createNotifyModule({ uow, registry, permissions, notify }));
      modules.register(
        createGlModule({
          uow,
          registry,
          permissions,
          storage,
          bankVault: new BankVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
        }),
      );
      // Performance and tracking (phase 4): permission keys now; routers in rows 4.3 to 4.8.
      modules.register(createPerformanceModule());
      modules.register(createTrackingModule());
      for (const attachable of modules.attachables()) attachables.register(attachable);
      for (const type of modules.recycleTypes()) recycleBin.register(type);
      modules.mount(api);
      api.use(createModuleRouter({ registry, modules }));
      api.use(createReportRouter({ uow, registry, permissions, reports: reportService }));
      api.use(
        createEventRouter({
          uow,
          registry,
          permissions,
          box: new SecretBox(env.DATA_ENCRYPTION_KEY),
          webhooks,
          eventTypes: () => [...modules.eventTypes(), ...WORKFLOW_EVENT_TYPES],
        }),
      );
      api.use(
        createJobRouter({
          registry,
          authorize: permissions.authorize,
          queues: () => [
            scheduler.getQueue(),
            emailQueue.getQueue(),
            pdfQueue.getQueue(),
            importQueue.getQueue(),
            relay.getQueue(),
            webhooks.getQueue(),
          ],
        }),
      );
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit,
          recycleBin,
        }),
      );
    },
    readinessChecks: [
      {
        name: 'database',
        check: async () => {
          await pool.query('SELECT 1');
        },
      },
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ],
  });

  // The permission catalogue is written before the first request is served, so the matrix
  // never offers fewer permissions than the code checks.
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...JOB_PERMISSIONS,
    ...modules.permissions(),
  ]);
  await syncEventTypes(prisma, [...modules.eventTypes(), ...WORKFLOW_EVENT_TYPES]);
  await syncReportDefinitions(prisma, [...KERNEL_REPORTS, ...modules.reports()]);
  await scheduler.start();
  emailQueue.startWorker();
  pdfQueue.startWorker();
  importQueue.startWorker();
  relay.startWorker();
  webhooks.startWorker();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Fibrex API listening');
  });

  realtimeHolder.gateway = new RealtimeGateway({ server, tokens, corsOrigins: env.CORS_ORIGINS });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after 10 s');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      void Promise.allSettled([
        realtimeHolder.gateway?.close(),
        scheduler.stop(),
        emailQueue.close(),
        pdfQueue.close(),
        importQueue.close(),
        relay.close(),
        webhooks.close(),
      ])
        .then(() => Promise.allSettled([pool.end(), redis.quit()]))
        .then(() => {
          logger.info('shutdown complete');
          process.exit(0);
        });
    });
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
}

try {
  await main();
} catch (err) {
  // The logger may not exist yet (bad configuration), so write plainly to stderr.
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(
      `Fatal start-up error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
  process.exit(1);
}
