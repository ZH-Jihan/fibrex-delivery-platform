/**
 * The Prisma schema must describe exactly what the hand-written SQL migrations create.
 *
 * Migrations are the source of truth (they also hold RLS, triggers and partitions, which
 * Prisma cannot express). This test asks Prisma for the SQL it would need to turn the
 * migrated test database into prisma/schema; anything other than an empty migration means
 * the .prisma files and the SQL have drifted apart.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionUrl } from './global-setup.js';
import { testDatabase } from './helpers.js';

const apiDir = path.resolve(import.meta.dirname, '../..');

describe('schema drift', () => {
  it('prisma/schema matches the migrated database', () => {
    const db = testDatabase();
    const output = execFileSync(
      process.execPath,
      [
        path.join(apiDir, 'node_modules/prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema',
        '--script',
      ],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          DATABASE_URL_OWNER: connectionUrl(db, db.owner),
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
          CHECKPOINT_DISABLE: '1',
        },
        encoding: 'utf8',
      },
    );
    const sql = output
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('Loaded Prisma config'))
      .join('\n');
    expect(sql).toBe('-- This is an empty migration.');
  });
});
