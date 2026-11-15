import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { moduleBoundaries, moduleOf } from './module-boundaries.js';

RuleTester.describe = describe;
RuleTester.it = it;

const root = '/repo/apps/api/src/modules';
const tester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

describe('moduleOf', () => {
  it('finds the module name and inner path, also for Windows paths', ({ expect }) => {
    expect(moduleOf(`${root}/loans/service.ts`)).toEqual({ name: 'loans', rest: 'service.ts' });
    expect(moduleOf('C:\\repo\\apps\\api\\src\\modules\\party\\index.ts')).toEqual({
      name: 'party',
      rest: 'index.ts',
    });
    expect(moduleOf('/repo/apps/api/src/kernel/db/client.ts')).toBeNull();
  });
});

tester.run('module-boundaries', moduleBoundaries, {
  valid: [
    { filename: `${root}/loans/service.ts`, code: "import { x } from './repository.js';" },
    { filename: `${root}/loans/service.ts`, code: "import { party } from '../party/index.js';" },
    { filename: `${root}/loans/service.ts`, code: "import { party } from '../party';" },
    {
      filename: `${root}/loans/service.ts`,
      code: "import { db } from '../../kernel/db/client.js';",
    },
    { filename: `${root}/loans/service.ts`, code: "import { z } from 'zod';" },
    {
      filename: '/repo/apps/api/src/kernel/x.ts',
      code: "import a from '../modules/party/service.js';",
    },
  ],
  invalid: [
    {
      filename: `${root}/loans/service.ts`,
      code: "import { repo } from '../party/repository.js';",
      errors: [{ messageId: 'internal' }],
    },
    {
      filename: `${root}/loans/jobs/daily.ts`,
      code: "export * from '../../party/internal/thing.js';",
      errors: [{ messageId: 'internal' }],
    },
    {
      filename: `${root}/loans/service.ts`,
      code: "const m = import('../party/service.js');",
      errors: [{ messageId: 'internal' }],
    },
    // A module's manifest is built by its index.ts; nobody else may reach for its parts.
    {
      filename: `${root}/loans/index.ts`,
      code: "import { createPartyRouter } from '../party/party-router.js';",
      errors: [{ messageId: 'internal' }],
    },
  ],
});
