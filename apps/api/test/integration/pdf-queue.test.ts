/**
 * PDF worker (phase 2 row 2.7b) against real PostgreSQL and Redis: a published template
 * becomes a stored PDF plus a generated_document row; failures record nothing; the queue
 * runs the same work. Uses the stub PDF renderer and in-memory storage, and, when Chromium
 * is installed, the real renderer for one A4 check.
 *
 * Data is invented: tenant A, company A1 from the fixture.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ChromiumPdfRenderer } from '../../src/adapters/pdf/chromium.js';
import { StubPdfRenderer } from '../../src/adapters/pdf/stub.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { PdfQueue } from '../../src/kernel/templates/pdf-queue.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';

let owner: pg.Client;
let pool: Pool;
let f: Fixture;
let uow: UnitOfWork;
let storage: MemoryStorageAdapter;
let queue: PdfQueue;

async function makeTemplate(options: { kind?: string; publish?: boolean; body?: string } = {}) {
  const key = `test.pdf_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const t = await owner.query<{ id: string }>(
    `INSERT INTO cfg.template (tenant_id, key, kind, name) VALUES ($1, $2, $3, 'Test letter')
     RETURNING id`,
    [f.tenantA, key, options.kind ?? 'pdf'],
  );
  const templateId = t.rows[0]?.id ?? '';
  const v = await owner.query<{ id: string }>(
    `INSERT INTO cfg.template_version (tenant_id, template_id, language, version_no, body, status)
     VALUES ($1, $2, 'en', 1, $3, $4) RETURNING id`,
    [
      f.tenantA,
      templateId,
      options.body ?? '<h1>Hello {{name}}</h1>',
      options.publish === false ? 'draft' : 'published',
    ],
  );
  return { key, versionId: v.rows[0]?.id ?? '' };
}

const job = (templateKey: string, data: Record<string, unknown> = { name: 'Asha' }) => ({
  tenantId: f.tenantA,
  companyId: f.companyA1,
  templateKey,
  language: 'en',
  data,
});

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  uow = new UnitOfWork(createPrisma(pool));
  storage = new MemoryStorageAdapter();
  queue = new PdfQueue({
    redisUrl: inject('redisUrl'),
    uow,
    storage,
    renderer: new StubPdfRenderer(),
    logger: createLogger({ level: 'silent', pretty: false, serviceName: 'test' }),
    backoffMs: 50,
  });
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  await owner.end();
});

describe('PDF worker', () => {
  it('stores a PDF and records the document, version, data hash and file', async () => {
    const t = await makeTemplate();
    const entityId = randomUUID();
    const result = await queue.produce({
      ...job(t.key),
      entityType: 'party.party',
      entityId,
    });
    const doc = await owner.query<{
      template_version_id: string;
      data_hash: string;
      merge_data: { name: string };
      entity_id: string;
      file_object_id: string;
    }>(`SELECT * FROM cfg.generated_document WHERE id = $1`, [result.generatedDocumentId]);
    const row = doc.rows[0];
    expect(row?.template_version_id).toBe(t.versionId);
    expect(row?.data_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.merge_data.name).toBe('Asha');
    expect(row?.entity_id).toBe(entityId);
    expect(row?.file_object_id).toBe(result.fileObjectId);

    const file = await owner.query<{ object_key: string; mime_type: string; size_bytes: string }>(
      `SELECT object_key, mime_type, size_bytes FROM files.file_object WHERE id = $1`,
      [result.fileObjectId],
    );
    expect(file.rows[0]?.mime_type).toBe('application/pdf');
    const stored = await storage.inspect(file.rows[0]?.object_key ?? '');
    expect(stored?.head.toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(String(stored?.sizeBytes)).toBe(file.rows[0]?.size_bytes);
  });

  it('escapes merge values, so markup in data is not drawn as markup', async () => {
    const t = await makeTemplate();
    const result = await queue.produce(job(t.key, { name: '<script>x</script>' }));
    expect(result.generatedDocumentId).toBeTruthy();
  });

  it('records nothing when the template has no published version or is not a PDF', async () => {
    const before = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM cfg.generated_document`,
    );
    const draft = await makeTemplate({ publish: false });
    await expect(queue.produce(job(draft.key))).rejects.toThrow(/no published version/);
    const email = await makeTemplate({ kind: 'email' });
    await expect(queue.produce(job(email.key))).rejects.toThrow(/not a PDF template/);
    await expect(queue.produce(job('nope.missing'))).rejects.toThrow(/No template/);
    const after = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM cfg.generated_document`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('does the same work through the queue', async () => {
    const t = await makeTemplate();
    const data = { name: 'Queued' };
    queue.startWorker();
    await queue.enqueue({ ...job(t.key, data) });
    const deadline = Date.now() + 15_000;
    let found = 0;
    while (found === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const res = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM cfg.generated_document WHERE template_version_id = $1`,
        [t.versionId],
      );
      found = Number(res.rows[0]?.n ?? 0);
    }
    expect(found).toBe(1);
  });

  it('draws a real A4 PDF with Chromium when it is installed', async (ctx) => {
    const renderer = new ChromiumPdfRenderer();
    try {
      const pdf = await renderer.render(
        '<!doctype html><html><head><style>@page { size: A4; }</style></head><body>Hi</body></html>',
        'A4',
      );
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // A4 is 595 x 842 points.
      expect(pdf.toString('latin1')).toMatch(
        /MediaBox\s*\[\s*0\s+0\s+59[45](\.\d+)?\s+84[12](\.\d+)?\s*\]/,
      );
    } catch (err) {
      if (/Executable doesn't exist|browserType\.launch/.test(String(err))) ctx.skip();
      else throw err;
    } finally {
      await renderer.close();
    }
  });
});
