/**
 * Storage adapter: the one doorway to object storage (SPEC 2.11).
 *
 * Purpose: the files module asks for a short-lived upload address, a short-lived download
 * address, and an inspection of what was stored. It never knows whether the bytes live in
 * SeaweedFS, S3 or memory. The browser uploads and downloads directly through the signed
 * addresses, so large files never pass through the API.
 *
 * Depends on: nothing. Used by: modules/files (through its service), src/main.ts.
 */
export interface UploadRequest {
  key: string;
  contentType: string;
  /** Exact size: the address is signed for this length, so another size is refused. */
  sizeBytes: number;
  expiresSeconds: number;
}

export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the uploader must send unchanged. */
  headers: Record<string, string>;
}

export interface DownloadRequest {
  key: string;
  filename: string;
  contentType: string;
  expiresSeconds: number;
}

/** What is really stored under a key, measured by the adapter, never taken on trust. */
export interface StoredObject {
  sizeBytes: number;
  sha256: string;
  /** The first bytes, for file-type checks. */
  head: Buffer;
}

export interface StorageAdapter {
  readonly bucket: string;
  presignUpload(request: UploadRequest): Promise<SignedUpload>;
  presignDownload(request: DownloadRequest): Promise<string>;
  /** Reads the object and reports its size, SHA-256 and first bytes; null when absent. */
  inspect(key: string): Promise<StoredObject | null>;
}

export const HEAD_BYTES = 16;
