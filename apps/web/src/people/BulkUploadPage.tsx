/**
 * Bulk scan upload and review (phase 3 row 3.7, SPEC 5.12) at /documents/bulk.
 *
 * Flow: staff choose many scans -> each is uploaded (files module) -> POST /bulk-uploads reads
 * them all with OCR and suggests a person and document type for each -> staff review every
 * item with the same confirm panel as a single scan (row 3.6) and confirm or reject it.
 *
 * Rules, and why:
 *   - Nothing is saved until staff confirm an item: a suggestion only pre-selects the person
 *     and the type. When the name read matches no single employee, no person is pre-selected.
 *   - Confirming goes through the item's own endpoint, which uses the same document rules as
 *     a single scan (see the API router).
 *   - Rejecting needs a reason, kept on the item.
 *
 * Depends on: api client, data/upload, i18n, ui, ./OcrScan.tsx, @fibrex/shared (limits).
 * Used by: App.tsx (route), people/manifest.ts (menu).
 */
import { useCallback, useEffect, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { BULK_UPLOAD_MAX_FILES } from '@fibrex/shared';
import { api } from '../api/client';
import { uploadFile } from '../data/upload';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, PageHeader, Pill, Select } from '../ui/components';
import { useToast } from '../ui/toast';
import { OcrConfirmPanel, type OcrJob } from './OcrScan';

export interface BulkItem {
  id: string;
  status: 'pending' | 'confirmed' | 'rejected';
  suggestedPartyId: string | null;
  suggestedPartyName: string | null;
  suggestedDocumentTypeId: string | null;
  rejectReason: string | null;
  job: OcrJob | null;
}
export interface BulkUpload {
  id: string;
  status: 'open' | 'completed';
  uploadedCount: number;
  pendingCount: number;
  items?: BulkItem[];
}
interface Choice {
  value: string;
  label: string;
}

export function BulkUploadPage() {
  const { t, language: lang } = useI18n();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [batch, setBatch] = useState<BulkUpload | null>(null);
  const [people, setPeople] = useState<Choice[]>([]);
  const [types, setTypes] = useState<Choice[]>([]);

  useEffect(() => {
    api<{ items: { partyId: string; displayName: string; employeeCode: string }[] }>('/employees', {
      query: { page: 1, pageSize: 200 },
    })
      .then((r) => {
        setPeople(
          r.items.map((e) => ({ value: e.partyId, label: `${e.employeeCode} ${e.displayName}` })),
        );
      })
      .catch(() => {
        setPeople([]);
      });
    api<{ items: { id: string; code: string; name: Record<string, string> }[] }>(
      '/document-types',
      { query: { appliesTo: 'party' } },
    )
      .then((r) => {
        setTypes(r.items.map((x) => ({ value: x.id, label: x.name[lang] ?? x.name.en ?? x.code })));
      })
      .catch(() => {
        setTypes([]);
      });
  }, [lang]);

  const reload = useCallback(async (id: string) => {
    setBatch(await api<BulkUpload>(`/bulk-uploads/${id}`));
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const fileObjectIds: string[] = [];
      for (const file of files) fileObjectIds.push(await uploadFile(file));
      setBatch(await api<BulkUpload>('/bulk-uploads', { method: 'POST', body: { fileObjectIds } }));
      setFiles([]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const items = batch?.items ?? [];
  return (
    <div className="page">
      <PageHeader title={t('bulk.title')} icon={ScanLine} description={t('bulk.description')} />
      <ErrorAlert error={error} />
      <section className="card">
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,application/pdf"
          aria-label={t('bulk.pick')}
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (chosen.length > BULK_UPLOAD_MAX_FILES) {
              setError(new Error(t('bulk.tooMany', { max: String(BULK_UPLOAD_MAX_FILES) })));
              return;
            }
            setError(null);
            setFiles(chosen);
          }}
        />
        {files.length > 0 ? (
          <p>
            {t('bulk.chosen', { count: String(files.length) })}{' '}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void start();
              }}
            >
              {busy ? t('bulk.reading') : t('bulk.read', { count: String(files.length) })}
            </Button>
          </p>
        ) : null}
      </section>

      {batch === null ? (
        <EmptyState title={t('bulk.none')} />
      ) : (
        <>
          <p role="status">
            {batch.pendingCount === 0
              ? t('bulk.allDone')
              : t('bulk.progress', {
                  pending: String(batch.pendingCount),
                  total: String(batch.uploadedCount),
                })}
          </p>
          {items.map((item, index) => (
            <ItemCard
              key={item.id}
              n={index + 1}
              batchId={batch.id}
              item={item}
              people={people}
              types={types}
              onChanged={(message) => {
                toast.show(message, 'success');
                void reload(batch.id).catch(setError);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ItemCard({
  n,
  batchId,
  item,
  people,
  types,
  onChanged,
}: {
  n: number;
  batchId: string;
  item: BulkItem;
  people: Choice[];
  types: Choice[];
  onChanged: (message: string) => void;
}) {
  const { t } = useI18n();
  const [partyId, setPartyId] = useState(item.suggestedPartyId ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);

  if (item.status !== 'pending') {
    return (
      <section className="card" aria-label={t('bulk.scan', { n: String(n) })}>
        <h3>{t('bulk.scan', { n: String(n) })}</h3>
        {item.status === 'confirmed' ? (
          <Pill tone="success">{t('bulk.confirmed')}</Pill>
        ) : (
          <Pill tone="danger">{t('bulk.rejected', { reason: item.rejectReason ?? '' })}</Pill>
        )}
      </section>
    );
  }
  const path = `/bulk-uploads/${batchId}/items/${item.id}`;
  return (
    <section className="card" aria-label={t('bulk.scan', { n: String(n) })}>
      <h3>{t('bulk.scan', { n: String(n) })}</h3>
      <ErrorAlert error={error} />
      <Select
        label={t('bulk.person')}
        value={partyId}
        placeholder={t('bulk.personPick')}
        hint={item.suggestedPartyId === null ? t('bulk.noSuggestion') : t('bulk.suggested')}
        options={people}
        onChange={(e) => {
          setPartyId(e.target.value);
        }}
      />
      {partyId !== '' && item.job !== null ? (
        <OcrConfirmPanel
          // A new person restarts the form, so the name check and owner are never stale.
          key={partyId}
          job={item.job}
          partyId={partyId}
          typeOptions={types}
          confirmPath={`${path}/confirm`}
          onDone={() => {
            onChanged(t('bulk.confirmed'));
          }}
          onCancel={() => {
            setPartyId('');
          }}
        />
      ) : null}
      {rejecting ? (
        <div>
          <label>
            {t('bulk.rejectReason')}
            <input
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </label>
          <Button
            variant="danger"
            disabled={reason.trim() === ''}
            onClick={() => {
              api(`${path}/reject`, { method: 'POST', body: { reason: reason.trim() } })
                .then(() => {
                  onChanged(t('bulk.itemRejected'));
                })
                .catch(setError);
            }}
          >
            {t('bulk.rejectConfirm')}
          </Button>
        </div>
      ) : (
        <Button
          onClick={() => {
            setRejecting(true);
          }}
        >
          {t('bulk.reject')}
        </Button>
      )}
    </section>
  );
}
