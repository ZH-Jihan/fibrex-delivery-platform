/**
 * File upload through the signed-upload flow (phase 2 rows 2.8b and 2.17b).
 *
 * Purpose: put a file in storage and register it, returning its file id, so a screen can then
 * hand that id to an import (data exchange wizard, bank statement import). The server checks
 * the stored bytes against the size and SHA-256 sent here.
 *
 * Depends on: api client. Used by: data/DataExchangePage.tsx, ledger/StatementsPage.tsx.
 */
import { api } from '../api/client';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** SHA-256 of a file as hex; the upload endpoint checks the stored bytes against it. */
export async function sha256Hex(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads a CSV or Excel file through the signed-upload flow and returns its file id. */
export async function uploadFile(file: File): Promise<string> {
  const mimeType =
    file.type !== ''
      ? file.type
      : file.name.toLowerCase().endsWith('.xlsx')
        ? XLSX_MIME
        : 'text/csv';
  const target = await api<{
    uploadToken: string;
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
  }>('/files/upload-url', {
    method: 'POST',
    body: {
      originalName: file.name,
      mimeType,
      sizeBytes: file.size,
      sha256: await sha256Hex(file),
    },
  });
  const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: file });
  if (!put.ok) throw new Error(`Upload failed (${String(put.status)})`);
  const done = await api<{ id: string }>('/files/complete', {
    method: 'POST',
    body: { uploadToken: target.uploadToken },
  });
  return done.id;
}
