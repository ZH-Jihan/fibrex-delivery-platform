/**
 * ESLint rule: module-boundaries
 *
 * Purpose: enforce SPEC 2.13 and CLAUDE.md "Modules talk through service interfaces and
 * events only; no imports of another module's internals".
 *
 * How it works:
 *   1. A file belongs to module X when its path contains `apps/api/src/modules/X/`.
 *   2. Every relative import in that file is resolved to an absolute path.
 *   3. If the target lies in a *different* module Y, the only allowed target is Y's public
 *      entry point (`modules/Y/index.ts`, or the folder `modules/Y` itself, which resolves
 *      to it). Anything deeper (service.ts, repository.ts ...) is reported.
 *   4. Imports inside the same module are not restricted.
 *
 * Depends on: Node `path` only. Used by: packages/eslint-config/index.js.
 */
import path from 'node:path';

const MODULES_SEGMENT = '/apps/api/src/modules/';

/** Normalise Windows separators so the same logic works on every OS. */
function toPosix(p) {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Returns `{ name, rest }` when `absPath` lies inside a module folder, otherwise null.
 * `rest` is the path inside the module ('' when the path is the module folder itself).
 */
export function moduleOf(absPath) {
  const p = toPosix(absPath);
  const at = p.indexOf(MODULES_SEGMENT);
  if (at === -1) return null;
  const tail = p.slice(at + MODULES_SEGMENT.length);
  const [name, ...rest] = tail.split('/');
  if (!name) return null;
  return { name, rest: rest.join('/') };
}

/** True when the path inside a module points at its public entry point. */
function isEntryPoint(rest) {
  return rest === '' || /^index(\.(ts|js))?$/.test(rest);
}

export const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: {
      description: "Disallow importing another module's internals; use its index.ts instead.",
    },
    schema: [],
    messages: {
      internal:
        "Module '{{from}}' must not import '{{target}}' from module '{{to}}'. Import from '{{to}}/index.ts' (its public interface) or use events.",
    },
  },
  create(context) {
    const filename = context.filename;
    const from = moduleOf(filename);
    if (!from) return {};

    function check(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const resolved = path.resolve(path.dirname(filename), source);
      const to = moduleOf(resolved);
      if (!to || to.name === from.name || isEntryPoint(to.rest)) return;
      context.report({
        node,
        messageId: 'internal',
        data: { from: from.name, to: to.name, target: to.rest },
      });
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ImportExpression: (node) =>
        node.source.type === 'Literal' && check(node.source, node.source.value),
    };
  },
};
