/**
 * Chart of accounts screen (phase 2 row 2.16a; PLAN 3.9 `account`, 5.11 `/accounts`).
 *
 * Flow: the whole chart is read from `GET /accounts/tree` and shown as one indented list
 * (headers bold, their accounts below). New accounts take a code, an English name, a type and
 * optionally a header parent; the server checks the rules (codes never change, a parent is a
 * non-postable header of the same type, no cycles), so the form only offers parents that can
 * be valid and shows the server's message otherwise. A code is fixed once saved because
 * posting rules name accounts by code (DECISIONS 2.14). Delete asks for a reason.
 *
 * Depends on: api client, auth, i18n, ui components, ledger-utils, @fibrex/shared (schemas).
 * Used by: App.tsx routes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import {
  ACCOUNT_TYPES,
  accountCodeSchema,
  type AccountType,
  currencyCodeSchema,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Field, PageHeader, Pill, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { accountName, flattenTree, type AccountNode, type FlatAccount } from './ledger-utils';

interface AccountForm {
  code: string;
  nameEn: string;
  type: AccountType;
  parentId: string;
  isPostable: boolean;
  isControl: boolean;
  currencyRestriction: string;
  description: string;
}

const emptyForm = (): AccountForm => ({
  code: '',
  nameEn: '',
  type: 'asset',
  parentId: '',
  isPostable: true,
  isControl: false,
  currencyRestriction: '',
  description: '',
});
const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** Checks the form before it is sent; returns the first problem as text, or null. */
export function accountFormProblem(form: AccountForm, isNew: boolean): string | null {
  if (isNew && !accountCodeSchema.safeParse(form.code).success) return 'gl.codeHint';
  if (form.nameEn.trim() === '') return 'gl.nameRequired';
  if (
    form.currencyRestriction !== '' &&
    !currencyCodeSchema.safeParse(form.currencyRestriction).success
  ) {
    return 'gl.currencyHint';
  }
  return null;
}

export function AccountsPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const [accounts, setAccounts] = useState<FlatAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<AccountForm | null>(null);
  const [editing, setEditing] = useState<FlatAccount | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FlatAccount | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: AccountNode[] }>('/accounts/tree')
      .then((r) => {
        setAccounts(flattenTree(r.items));
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const text = search.trim().toLowerCase();
    if (text === '') return accounts;
    return accounts.filter(
      (a) =>
        a.code.toLowerCase().includes(text) ||
        accountName(a, language).toLowerCase().includes(text),
    );
  }, [accounts, search, language]);

  // A parent must be a header (not postable) of the same type, and never the account itself.
  const parentOptions =
    form === null
      ? []
      : accounts
          .filter((a) => !a.isPostable && a.type === form.type && a.id !== editing?.id)
          .map((a) => ({ value: a.id, label: `${a.code} ${accountName(a, language)}` }));

  const save = () => {
    if (form === null) return;
    const found = accountFormProblem(form, editing === null);
    if (found !== null) {
      setProblem(t(found as 'gl.codeHint'));
      return;
    }
    setProblem(null);
    // Keep the other languages' names; only English is edited on this screen.
    const name = { ...(editing?.name ?? {}), en: form.nameEn.trim() };
    const common = {
      name,
      type: form.type,
      parentId: form.parentId === '' ? null : form.parentId,
      isPostable: form.isPostable,
      isControl: form.isControl,
      currencyRestriction: form.currencyRestriction === '' ? null : form.currencyRestriction,
      description: form.description.trim() === '' ? null : form.description.trim(),
    };
    const job =
      editing === null
        ? api('/accounts', { method: 'POST', body: { ...common, code: form.code } })
        : api(`/accounts/${editing.id}`, {
            method: 'PATCH',
            headers: ifMatch(editing.version),
            body: common,
          });
    job
      .then(() => {
        setForm(null);
        setEditing(null);
        setError(null);
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const typeOptions = ACCOUNT_TYPES.map((type) => ({ value: type, label: t(`gl.type.${type}`) }));

  return (
    <>
      <PageHeader
        title={t('gl.accountsTitle')}
        icon={BookOpen}
        description={t('gl.accountsIntro')}
        actions={
          auth.can('gl.account.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setForm(emptyForm());
                setProblem(null);
              }}
            >
              {t('gl.newAccount')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {form === null ? null : (
        <section
          className="card"
          aria-label={editing === null ? t('gl.newAccount') : t('gl.editAccount')}
        >
          <h2>{editing === null ? t('gl.newAccount') : t('gl.editAccount')}</h2>
          <Field
            label={t('gl.code')}
            hint={t('gl.codeHint')}
            value={form.code}
            readOnly={editing !== null}
            onChange={(e) => {
              setForm({ ...form, code: e.target.value.toUpperCase() });
            }}
          />
          <Field
            label={t('gl.nameEn')}
            value={form.nameEn}
            onChange={(e) => {
              setForm({ ...form, nameEn: e.target.value });
            }}
          />
          <Select
            label={t('gl.accountType')}
            options={typeOptions}
            value={form.type}
            onChange={(e) => {
              // A different type means the chosen header no longer fits.
              setForm({ ...form, type: e.target.value as AccountType, parentId: '' });
            }}
          />
          <Select
            label={t('gl.parent')}
            options={parentOptions}
            placeholder={t('gl.noParent')}
            value={form.parentId}
            onChange={(e) => {
              setForm({ ...form, parentId: e.target.value });
            }}
          />
          <Checkbox
            label={t('gl.postable')}
            checked={form.isPostable}
            onChange={(e) => {
              setForm({ ...form, isPostable: e.target.checked });
            }}
          />
          <Checkbox
            label={t('gl.control')}
            checked={form.isControl}
            onChange={(e) => {
              setForm({ ...form, isControl: e.target.checked });
            }}
          />
          <Field
            label={t('gl.currencyRestriction')}
            hint={t('gl.currencyHint')}
            value={form.currencyRestriction}
            onChange={(e) => {
              setForm({ ...form, currencyRestriction: e.target.value.toUpperCase() });
            }}
          />
          <Field
            label={t('gl.description')}
            value={form.description}
            onChange={(e) => {
              setForm({ ...form, description: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={save}>
            {t('common.save')}
          </Button>
          <Button
            onClick={() => {
              setForm(null);
              setEditing(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      )}
      <DataTable
        columns={[
          {
            key: 'code',
            header: t('gl.code'),
            value: (a) => a.code,
            render: (a) => (a.isPostable ? a.code : <strong>{a.code}</strong>),
          },
          {
            key: 'name',
            header: t('gl.name'),
            value: (a) => accountName(a, language),
            // Indent by depth so the tree reads as a tree; headers in bold.
            render: (a) => (
              <span style={{ paddingInlineStart: `${String(a.depth * 1.25)}rem` }}>
                {a.isPostable ? (
                  accountName(a, language)
                ) : (
                  <strong>{accountName(a, language)}</strong>
                )}
              </span>
            ),
          },
          { key: 'type', header: t('gl.accountType'), value: (a) => t(`gl.type.${a.type}`) },
          {
            key: 'kind',
            header: t('gl.kind'),
            value: (a) => (a.isPostable ? t('gl.postable') : t('gl.header')),
            render: (a) => (
              <>
                {a.isPostable ? null : <Pill>{t('gl.header')}</Pill>}
                {a.isControl ? <Pill tone="info">{t('gl.control')}</Pill> : null}
                {a.currencyRestriction === null ? null : (
                  <Pill tone="accent">{a.currencyRestriction}</Pill>
                )}
              </>
            ),
          },
        ]}
        rows={shown}
        rowKey={(a) => a.id}
        total={shown.length}
        page={1}
        pageSize={Math.max(shown.length, 1)}
        onPageChange={() => undefined}
        search={search}
        onSearch={setSearch}
        loading={loading}
        error={null}
        exportName="chart-of-accounts"
        actions={(a) => (
          <>
            {auth.can('gl.account.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setEditing(a);
                  setProblem(null);
                  setForm({
                    code: a.code,
                    nameEn: a.name.en ?? '',
                    type: a.type,
                    parentId: a.parentId ?? '',
                    isPostable: a.isPostable,
                    isControl: a.isControl,
                    currencyRestriction: a.currencyRestriction ?? '',
                    description: a.description ?? '',
                  });
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('gl.account.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving(a);
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          const target = removing;
          setRemoving(null);
          setReason('');
          api(`/accounts/${target.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: ifMatch(target.version),
          })
            .then(load)
            .catch((e: unknown) => {
              setError(e);
            });
        }}
      >
        <Field
          label={t('users.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
