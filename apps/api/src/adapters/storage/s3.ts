/**
 * S3-compatible storage adapter (SeaweedFS in development, any S3 service in production).
 *
 * Purpose: signed upload and download addresses, and inspection of a stored object.
 * Upload addresses are signed for the exact content type and length, so the size the
 * user declared is the size S3 accepts.
 *
 * Depends on: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, ./interface.ts.
 * Used by: src/main.ts.
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  HEAD_BYTES,
  type DownloadRequest,
  type SignedUpload,
  type StorageAdapter,
  type StoredObject,
  type UploadRequest,
} from './interface.js';

export interface S3Config {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

/** A filename safe inside a Content-Disposition header. */
function headerSafe(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 200);
}

export class S3StorageAdapter implements StorageAdapter {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      // Checksums are computed by inspect(), so the SDK need not add its own to uploads.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignUpload(request: UploadRequest): Promise<SignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: request.key,
        ContentType: request.contentType,
        ContentLength: request.sizeBytes,
      }),
      {
        expiresIn: request.expiresSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return { url, method: 'PUT', headers: { 'Content-Type': request.contentType } };
  }

  presignDownload(request: DownloadRequest): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: request.key,
        ResponseContentType: request.contentType,
        ResponseContentDisposition: `attachment; filename="${headerSafe(request.filename)}"`,
      }),
      { expiresIn: request.expiresSeconds },
    );
  }

  async inspect(key: string): Promise<StoredObject | null> {
    let body: AsyncIterable<Uint8Array> | undefined;
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      body = out.Body as AsyncIterable<Uint8Array> | undefined;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
    if (body === undefined) return null;
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    // Streamed: a large file is never held in memory.
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
      if (head.length < HEAD_BYTES) {
        head = Buffer.concat([head, Buffer.from(chunk)]).subarray(0, HEAD_BYTES);
      }
    }
    return { sizeBytes: size, sha256: hash.digest('hex'), head };
  }
}
