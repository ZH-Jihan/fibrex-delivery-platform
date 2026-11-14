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
import { StubMessagingAdapter } from './adapters/messaging/stub.js';
import { API_PREFIX, createApp } from './app.js';
import { createAuditRouter } from './kernel/audit/audit-router.js';
import { createAuditService } from './kernel/audit/audit-service.js';
import { RecycleBin } from './kernel/audit/recycle-bin.js';
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
import { UnitOfWork } from './kernel/db/unit-of-work.js';
import { createLogger } from './kernel/observability/logger.js';
import { createAccessAdminRouter } from './kernel/permissions/access-admin-router.js';
import { AccessAdminService } from './kernel/permissions/access-admin-service.js';
import { KERNEL_PERMISSIONS, syncPermissionCatalogue } from './kernel/permissions/catalogue.js';
import { PermissionService } from './kernel/permissions/permission-service.js';
import { createRedis } from './kernel/redis/client.js';
import { S3StorageAdapter } from './adapters/storage/s3.js';
import {
  AttachableRegistry,
  FILES_PERMISSIONS,
  FilesService,
  createFilesRouter,
} from './modules/files/index.js';
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyVault,
  createPartyModule,
} from './modules/party/index.js';

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
  const messaging = new StubMessagingAdapter({
    logger,
    revealText: env.NODE_ENV !== 'production',
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
  const apiKeys = new ApiKeyResolver({ prisma, uow, redis, logger });

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
      const party = createPartyModule({
        uow,
        registry,
        permissions,
        audit,
        vault: new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
        references: partyReferences,
      });
      attachables.register(party.attachable);
      for (const type of party.recycleTypes) recycleBin.register(type);
      for (const router of party.routers) api.use(router);
      api.use(createFilesRouter({ uow, registry, permissions, files, attachables }));
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
    ...PARTY_PERMISSIONS,
    ...FILES_PERMISSIONS,
  ]);

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Fibrex API listening');
  });

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
      void Promise.allSettled([pool.end(), redis.quit()]).then(() => {
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
