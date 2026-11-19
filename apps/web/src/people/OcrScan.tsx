/**
 * OCR scan to pre-fill to confirm (phase 3 row 3.6, SPEC 5.12), used on the employee
 * profile's Documents tab.
 *
 * Flow: the person picks a scan -> it is uploaded (files module) -> POST /ocr/jobs reads it
 * -> this panel shows the values read, each with its confidence, and the warnings -> the
 * person corrects what is wrong and presses Confirm -> POST /ocr/jobs/{id}/confirm creates
 * the document with the scan attached.
 *
 * Rules, and why:
 *   - Nothing is saved until Confirm: the reading only fills the form (the API enforces the
 *     same; a job is not a document).
 *   - Every field shows how sure the OCR was; below the shared threshold it says "check
 *     this", so low-confidence values are not accepted by habit.
 *   - Warnings (name mismatch, expired, duplicate ...) are shown above the form in words.
 *   - While the stub adapter is in use (provider `stub`), a note says the values are demo
 *     values, so nobody mistakes them for a real reading.
 *
 * Depends on: api client, i18n, ui (components, EntityForm), @fibrex/shared (document schema,
 * OCR threshold). Used by: ./EmployeeProfilePage.tsx.
 */
import { documentCreateSchema, OCR_LOW_CONFIDENCE } from '@fibrex/shared';
import { api } from '../api/client';
import { useI18n, type TFunction } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { Pill } from '../ui/components';
import { EntityForm, type FormField } from '../ui/EntityForm';

interface Reading {
  value: string | null;
  confidence: number;
}
export interface OcrJob {
  id: string;
  status: string;
  provider: string;
  flags: string[];
  error: string | null;
  fields: {
    documentTypeId: Reading;
    number: Reading & { masked: string | null };
    holderName: Reading;
    issueDate: Reading;
    expiryDate: Reading;
  };
}

/** The hint under a pre-filled box: how sure the OCR was (tested). */
export function confidenceText(t: TFunction, reading: Reading): string {
  if (reading.value === null || reading.value === '') return t('ocr.notRead');
  const percent = String(Math.round(reading.confidence * 100));
  return reading.confidence < OCR_LOW_CONFIDENCE
    ? t('ocr.lowConfidence', { percent })
    : t('ocr.confidence', { percent });
}

export function OcrConfirmPanel({
  job,
  partyId,
  typeOptions,
  confirmPath,
  onDone,
  onCancel,
}: {
  job: OcrJob;
  partyId: string;
  typeOptions: readonly { value: string; label: string }[];
  /** Where the checked values are sent; bulk upload (row 3.7) confirms through its item. */
  confirmPath?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const r = job.fields;
  const fields: FormField[] = [
    {
      name: 'documentTypeId',
      label: t('employees.docs.type'),
      type: 'select',
      options: [{ value: '', label: '' }, ...typeOptions],
      hint: confidenceText(t, r.documentTypeId),
    },
    { name: 'number', label: t('employees.docs.number'), hint: confidenceText(t, r.number) },
    {
      name: 'issueDate',
      label: t('employees.docs.issueDate'),
      hint: `YYYY-MM-DD. ${confidenceText(t, r.issueDate)}`,
    },
    {
      name: 'expiryDate',
      label: t('employees.docs.expiryDate'),
      hint: `YYYY-MM-DD. ${confidenceText(t, r.expiryDate)}`,
    },
  ];
  // Only values that were read are filled in; the rest stay empty for the person to type.
  const initial: Record<string, unknown> = {};
  if (r.documentTypeId.value !== null) initial.documentTypeId = r.documentTypeId.value;
  if (r.number.value !== null) initial.number = r.number.value;
  if (r.issueDate.value !== null) initial.issueDate = r.issueDate.value;
  if (r.expiryDate.value !== null) initial.expiryDate = r.expiryDate.value;

  return (
    <section className="card" aria-label={t('ocr.title')}>
      <h3>{t('ocr.title')}</h3>
      {job.provider === 'stub' ? <p className="muted">{t('ocr.stubNote')}</p> : null}
      {job.status === 'failed' ? <p>{t('ocr.failed')}</p> : null}
      {r.holderName.value !== null ? (
        <p>
          {t('ocr.holderName')}: <strong>{r.holderName.value}</strong>{' '}
          <span className="muted">({confidenceText(t, r.holderName)})</span>
        </p>
      ) : null}
      {job.flags.length > 0 ? (
        <ul className="plain-list" aria-label={t('ocr.warnings')}>
          {job.flags.map((flag) => (
            <li key={flag}>
              <Pill tone={flag === 'low_confidence' ? 'warning' : 'danger'}>
                {t(`ocr.flag.${flag}` as MessageKey)}
              </Pill>
            </li>
          ))}
        </ul>
      ) : null}
      <EntityForm
        fields={fields}
        initial={initial}
        submitLabel={t('ocr.confirm')}
        schema={{
          safeParse: (value) =>
            documentCreateSchema.safeParse({
              ownerType: 'party',
              ownerId: partyId,
              ...(value as Record<string, unknown>),
            }),
        }}
        onCancel={onCancel}
        onSubmit={async (values) => {
          await api(confirmPath ?? `/ocr/jobs/${job.id}/confirm`, {
            method: 'POST',
            body: { ownerType: 'party', ownerId: partyId, ...values },
          });
          onDone();
        }}
      />
    </section>
  );
}
