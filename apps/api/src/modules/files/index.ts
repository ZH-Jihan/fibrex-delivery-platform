/**
 * Files module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: signed uploads and downloads, attachments with versions, raw inputs.
 * `createFilesModule` returns the module manifest for the kernel module registry; the
 * record types that take attachments come from the other modules' manifests
 * (`attachables`) and are fed into the `AttachableRegistry` by `main.ts`.
 *
 * Depends on: ./files-service.ts, ./files-router.ts, ./attachable.ts, adapters/storage,
 * kernel/module-registry. Used by: src/main.ts, and by modules that accept attachments
 * (they declare an attachable in their manifest, they never touch the tables).
 */
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';
import { createFilesRouter, type FilesRouterDeps } from './files-router.js';

export { AttachableRegistry, type AttachableType } from './attachable.js';
export { FilesService, RAW_INPUT_KINDS, type FilesServiceDeps } from './files-service.js';
export {
  createAttachmentRepository,
  createFilesRouter,
  type AttachmentRow,
} from './files-router.js';

export const FILES_PERMISSIONS: readonly PermissionDef[] = [
  permission('files', 'files.file', 'upload', 'Upload files'),
  permission('files', 'files.file', 'download', 'Download files (audited)'),
  ...crudPermissions('files', 'files.attachment', 'file attachments'),
];

export function createFilesModule(deps: FilesRouterDeps): ModuleManifest {
  return {
    key: 'files',
    label: 'Files and attachments',
    permissions: FILES_PERMISSIONS,
    routers: [createFilesRouter(deps)],
  };
}
