/**
 * Bank statements screen (phase 2 row 2.17b; PLAN 3.9 `bank_statement`).
 *
 * List the imported statements and import a new one from a CSV or Excel (.xlsx) file: the file
 * goes through the signed upload, then `POST /bank-statements` reads it with the column
 * mapping typed here (a date column and its order, either one signed amount column or a
 * debit and a credit column, optional reference and description columns). The mapping is
 * data for this import only, so a new bank's layout never needs a code change. The server
 * refuses the whole file if one row is wrong and lists the rows; nothing is corrected
 * silently. A statement with matched lines cannot be deleted: unmatch them first.
 *
 * Depends on: api client, auth, i18n, ui, data/upload, bank-ui. Used by: App.tsx routes.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileSpreadsheet, GitCompareArrows, Trash2, Upload } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { uploadFile } from '../data/upload';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Pill, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { ifMatch, ModalForm, ReasonDialog, useApiList } from './bank-ui';
import type { BankAccountRow } from './BankPage';

export interface StatementRow {
  id: string;
  companyBankAccountId: string;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  lineCount: number;
  totalIn: string;
  totalOut: string;
  status: 'open' | 'reconciled';
  version: number;
}

const PAGE_SIZE = 50;
const DATE_ORDERS = ['ymd', 'dmy', 'mdy'] as const;

interface ImportForm {
  companyBankAccountId: string;
  file: File | null;
  dateColumn: string;
  dateFormat: string;
  split: boolean;
  amountColumn: string;
  debitColumn: string;
  creditColumn: string;
  referenceColumn: string;
  descriptionColumn: string;
  note: string;
}

/**
 * The mapping object the API expects: only the columns that were filled in, and either the
 * single amount column or the debit and credit pair (never both).
 */
export function buildMapping(form: Omit<ImportForm, 'companyBankAccountId' | 'file' | 'note'>) {
  const text = (v: string) => (v.trim() === '' ? undefined : v.trim());
  return {
    dateColumn: form.dateColumn.trim(),
    dateFormat: form.dateFormat,
    ...(form.split
      ? { debitColumn: text(form.debitColumn), creditColumn: text(form.creditColumn) }
      : { amountColumn: text(form.amountColumn) }),
    referenceColumn: text(form.referenceColumn),
    descriptionColumn: text(form.descriptionColumn),
  };
}

export function StatementsPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const list = useApiList<StatementRow>('/bank-statements', { page, pageSize: PAGE_SIZE });
  const bankAccounts = useApiList<BankAccountRow>('/company-bank-accounts', { pageSize: 200 });
  const [form, setForm] = useState<ImportForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<StatementRow | null>(null);
  const [error, setError] = useState<unknown>(null);

  const accountName = (id: string) => {
    const a = bankAccounts.rows.find((row) => row.id === id);
    return a === undefined ? id : `${a.bankName} ${a.ibanMasked}`;
  };

  const startImport = () => {
    setForm({
      companyBankAccountId: bankAccounts.rows[0]?.id ?? '',
      file: null,
      dateColumn: 'Date',
      dateFormat: 'ymd',
      split: false,
      amountColumn: 'Amount',
      debitColumn: 'Debit',
      creditColumn: 'Credit',
      referenceColumn: '',
      descriptionColumn: '',
      note: '',
    });
  };

  const submit = () => {
    if (form === null || busy) return;
    const { file } = form;
    if (file === null) return;
    const f = form;
    setBusy(true);
    uploadFile(file)
      .then((fileObjectId) =>
        api('/bank-statements', {
          method: 'POST',
          body: {
            companyBankAccountId: f.companyBankAccountId,
            fileObjectId,
            mapping: buildMapping(f),
            note: f.note.trim() === '' ? null : f.note.trim(),
          },
        }),
      )
      .then(() => {
        setForm(null);
        setError(null);
        list.reload();
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <PageHeader
        title={t('bank.statementsTitle')}
        icon={FileSpreadsheet}
        description={t('bank.statementsIntro')}
        actions={
          auth.can('gl.bank_statement.create') && bankAccounts.rows.length > 0 ? (
            <Button variant="primary" icon={Upload} onClick={startImport}>
              {t('bank.import')}
            </Button>
          ) : null
        }
      />
      {error !== null ? <ErrorAlert error={error} /> : null}
      <DataTable
        columns={[
          { key: 'file', header: t('bank.file'), value: (s: StatementRow) => s.fileName },
          {
            key: 'account',
            header: t('bank.bankAccount'),
            value: (s) => accountName(s.companyBankAccountId),
          },
          {
            key: 'period',
            header: t('bank.period'),
            value: (s) => `${s.periodFrom} – ${s.periodTo}`,
          },
          { key: 'lines', header: t('bank.lines'), value: (s) => s.lineCount },
          { key: 'in', header: t('bank.totalIn'), value: (s) => `${s.totalIn} ${s.currency}` },
          { key: 'out', header: t('bank.totalOut'), value: (s) => `${s.totalOut} ${s.currency}` },
          {
            key: 'status',
            header: t('gl.state'),
            value: (s) => t(`bank.status.${s.status}`),
            render: (s) => (
              <Pill tone={s.status === 'reconciled' ? 'success' : 'warning'}>
                {t(`bank.status.${s.status}`)}
              </Pill>
            ),
          },
        ]}
        rows={list.rows}
        rowKey={(s) => s.id}
        total={list.total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        exportName="bank-statements"
        actions={(s) => (
          <>
            {auth.can('gl.reconciliation.read') ? (
              <Link className="btn btn-link" to={`/ledger/reconciliation?statement=${s.id}`}>
                <GitCompareArrows aria-hidden="true" size={16} /> {t('bank.reconcile')}
              </Link>
            ) : null}
            {auth.can('gl.bank_statement.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving(s);
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />

      <ModalForm
        open={form !== null}
        title={t('bank.import')}
        submitLabel={busy ? t('common.loading') : t('bank.import')}
        onClose={() => {
          setForm(null);
        }}
        onSubmit={submit}
      >
        {form === null ? null : (
          <>
            <Select
              label={t('bank.bankAccount')}
              options={bankAccounts.rows.map((a) => ({
                value: a.id,
                label: `${a.bankName} ${a.ibanMasked}`,
              }))}
              value={form.companyBankAccountId}
              onChange={(e) => {
                setForm({ ...form, companyBankAccountId: e.target.value });
              }}
            />
            <Field
              label={t('bank.file')}
              hint={t('bank.fileHint')}
              type="file"
              required
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setForm({ ...form, file: e.target.files?.[0] ?? null });
              }}
            />
            <p className="muted">{t('bank.mappingHint')}</p>
            <Field
              label={t('bank.dateColumn')}
              required
              value={form.dateColumn}
              onChange={(e) => {
                setForm({ ...form, dateColumn: e.target.value });
              }}
            />
            <Select
              label={t('bank.dateOrder')}
              options={DATE_ORDERS.map((o) => ({ value: o, label: t(`bank.order.${o}`) }))}
              value={form.dateFormat}
              onChange={(e) => {
                setForm({ ...form, dateFormat: e.target.value });
              }}
            />
            <Select
              label={t('bank.amountLayout')}
              options={[
                { value: 'one', label: t('bank.amountOne') },
                { value: 'two', label: t('bank.amountTwo') },
              ]}
              value={form.split ? 'two' : 'one'}
              onChange={(e) => {
                setForm({ ...form, split: e.target.value === 'two' });
              }}
            />
            {form.split ? (
              <>
                <Field
                  label={t('bank.debitColumn')}
                  required
                  value={form.debitColumn}
                  onChange={(e) => {
                    setForm({ ...form, debitColumn: e.target.value });
                  }}
                />
                <Field
                  label={t('bank.creditColumn')}
                  required
                  value={form.creditColumn}
                  onChange={(e) => {
                    setForm({ ...form, creditColumn: e.target.value });
                  }}
                />
              </>
            ) : (
              <Field
                label={t('bank.amountColumn')}
                required
                value={form.amountColumn}
                onChange={(e) => {
                  setForm({ ...form, amountColumn: e.target.value });
                }}
              />
            )}
            <Field
              label={t('bank.referenceColumn')}
              value={form.referenceColumn}
              onChange={(e) => {
                setForm({ ...form, referenceColumn: e.target.value });
              }}
            />
            <Field
              label={t('bank.descriptionColumn')}
              value={form.descriptionColumn}
              onChange={(e) => {
                setForm({ ...form, descriptionColumn: e.target.value });
              }}
            />
            <Field
              label={t('bank.note')}
              value={form.note}
              onChange={(e) => {
                setForm({ ...form, note: e.target.value });
              }}
            />
          </>
        )}
      </ModalForm>

      <ReasonDialog
        open={removing !== null}
        title={t('common.delete')}
        hint={
          removing === null ? undefined : t('bank.deleteStatementHint', { name: removing.fileName })
        }
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={(reason) => {
          if (removing === null) return;
          const target = removing;
          setRemoving(null);
          api(`/bank-statements/${target.id}`, {
            method: 'DELETE',
            body: { reason },
            headers: ifMatch(target.version),
          })
            .then(() => {
              setError(null);
              list.reload();
            })
            .catch((e: unknown) => {
              setError(e);
            });
        }}
      />
    </>
  );
}
