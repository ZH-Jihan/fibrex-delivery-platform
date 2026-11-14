/**
 * STUB storage adapter that keeps objects in memory (listed in docs/PROGRESS.md).
 *
 * Purpose: tests, and any development setup without the object store. Nothing is
 * persisted. `put` stands in for the browser's upload to the signed address.
 *
 * Depends on: ./interface.ts. Used by: integration tests.
 */
import { createHash } from 'node:crypto';
import {
  HEAD_BYTES,
  type DownloadRequest,
  type SignedUpload,
  type StorageAdapter,
  type StoredObject,
  type UploadRequest,
} from './interface.js';

export class MemoryStorageAdapter implements StorageAdapter {
  readonly bucket = 'memory';
  private readonly objects = new Map<string, Buffer>();

  /** What the browser would do with the upload address. */
  put(key: string, bytes: Buffer): void {
    this.objects.set(key, bytes);
  }

  presignUpload(request: UploadRequest): Promise<SignedUpload> {
    return Promise.resolve({
      url: `memory://upload/${request.key}?expires=${String(request.expiresSeconds)}`,
      method: 'PUT',
      headers: { 'Content-Type': request.contentType },
    });
  }

  presignDownload(request: DownloadRequest): Promise<string> {
    return Promise.resolve(
      `memory://download/${request.key}?expires=${String(request.expiresSeconds)}`,
    );
  }

  inspect(key: string): Promise<StoredObject | null> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return Promise.resolve(null);
    return Promise.resolve({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      head: bytes.subarray(0, HEAD_BYTES),
    });
  }
}
