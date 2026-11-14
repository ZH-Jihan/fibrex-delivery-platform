/**
 * Files module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: signed uploads and downloads, attachments with versions, raw inputs.
 * Depends on: ./files-service.ts, ./files-router.ts, ./attachable.ts, adapters/storage.
 * Used by: src/main.ts, and by modules that accept attachments (they register an
 * AttachableType here, they never touch the tables).
 */
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';

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
