/**
 * Cash and bank screen (phase 2 row 2.17b; PLAN 3.9 `cash_location`, `company_bank_account`).
 *
 * Two lists on one page: the places the company holds money (hand, bank, card, wallet), each
 * tied to the ledger account that carries its balance, and the company's bank accounts at its
 * bank locations. A location holds no balance of its own (SPEC 2.9): the ledger does.
 *
 * The bank account number (IBAN) is write-only here: it is typed once when an account is
 * added or changed and is never shown again; lists show only the masked form the server sends
 * (last four characters). It is kept in a plain form field, never in the URL, local storage
 * or a log.
 *
 * Depends on: api client, auth, i18n, ui, ledger-utils, bank-ui. Used by: App.tsx routes.
 */
import { useEffect, useState } from 'react';
import { Landmark, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { ifMatch, ModalForm, ReasonDialog, useApiList } from './bank-ui';
import { accountLabel, flattenTree, type AccountNode, type FlatAccount } from './ledger-utils';

export interface CashLocationRow {
  id: string;
  name: string;
  kind: 'hand' | 'bank' | 'card' | 'wallet';
  accountId: string;
  currency: string;
  version: number;
}
export interface BankAccountRow {
  id: string;
  cashLocationId: string;
  bankName: string;
  ibanMasked: string;
  wpsEmployerId: string | null;
  version: number;
}

const KINDS = ['hand', 'bank', 'card', 'wallet'] as const;
const PAGE = { pageSize: 200 };

export function BankPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const locations = useApiList<CashLocationRow>('/cash-locations', PAGE);
  const accounts = useApiList<BankAccountRow>('/company-bank-accounts', PAGE);
  const [tree, setTree] = useState<FlatAccount[]>([]);
  const [error, setError] = useState<unknown>(null);

  const [locForm, setLocForm] = useState<{
    editing: CashLocationRow | null;
    name: string;
    kind: string;
    accountId: string;
    currency: string;
  } | null>(null);
  const [bankForm, setBankForm] = useState<{
    editing: BankAccountRow | null;
    cashLocationId: string;
    bankName: string;
    iban: string;
    wpsEmployerId: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{ path: string; version: number; label: string } | null>(
    null,
  );

  // Ledger accounts a location can use (postable asset accounts).
  useEffect(() => {
    if (!auth.can('gl.account.read')) return;
    api<{ items: AccountNode[] }>('/accounts/tree')
      .then((r) => {
        setTree(flattenTree(r.items));
      })
      .catch(() => undefined);
  }, [auth]);
  const assetAccounts = tree.filter((a) => a.isPostable && a.type === 'asset');
  const bankLocations = locations.rows.filter((l) => l.kind === 'bank');
  const locationName = (id: string) => locations.rows.find((l) => l.id === id)?.name ?? id;

  const fail = (e: unknown) => {
    setError(e);
  };

  const saveLocation = () => {
    if (locForm === null) return;
    const form = locForm;
    const request = form.editing
      ? api(`/cash-locations/${form.editing.id}`, {
          method: 'PATCH',
          headers: ifMatch(form.editing.version),
          body: { name: form.name.trim(), accountId: form.accountId },
        })
      : api('/cash-locations', {
          method: 'POST',
          body: {
            name: form.name.trim(),
            kind: form.kind,
            accountId: form.accountId,
            currency: form.currency.trim().toUpperCase(),
          },
        });
    request
      .then(() => {
        setLocForm(null);
        setError(null);
        locations.reload();
      })
      .catch(fail);
  };

  const saveBank = () => {
    if (bankForm === null) return;
    const form = bankForm;
    // The number is sent only when typed; leaving it empty on edit keeps the stored one.
    const iban = form.iban.trim() === '' ? {} : { iban: form.iban };
    const wps = form.wpsEmployerId.trim() === '' ? null : form.wpsEmployerId.trim();
    const request = form.editing
      ? api(`/company-bank-accounts/${form.editing.id}`, {
          method: 'PATCH',
          headers: ifMatch(form.editing.version),
          body: { bankName: form.bankName.trim(), wpsEmployerId: wps, ...iban },
        })
      : api('/company-bank-accounts', {
          method: 'POST',
          body: {
            cashLocationId: form.cashLocationId,
            bankName: form.bankName.trim(),
            wpsEmployerId: wps,
            ...iban,
          },
        });
    request
      .then(() => {
        setBankForm(null);
        setError(null);
        accounts.reload();
      })
      .catch(fail);
  };

  return (
    <>
      <PageHeader
        title={t('bank.title')}
        icon={Landmark}
        description={t('bank.intro')}
        actions={
          auth.can('gl.cash_location.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setLocForm({
                  editing: null,
                  name: '',
                  kind: 'bank',
                  accountId: '',
                  currency: 'QAR',
                });
              }}
            >
              {t('bank.newLocation')}
            </Button>
          ) : null
        }
      />
      {error !== null ? <ErrorAlert error={error} /> : null}
      <h2>{t('bank.locations')}</h2>
      <DataTable
        columns={[
          { key: 'name', header: t('gl.name'), value: (l: CashLocationRow) => l.name },
          { key: 'kind', header: t('bank.kind'), value: (l) => t(`bank.kind.${l.kind}`) },
          {
            key: 'account',
            header: t('gl.account'),
            value: (l) => accountLabel(tree, l.accountId, language),
          },
          { key: 'currency', header: t('gl.currency'), value: (l) => l.currency },
        ]}
        rows={locations.rows}
        rowKey={(l) => l.id}
        total={locations.total}
        page={1}
        pageSize={Math.max(locations.rows.length, 1)}
        onPageChange={() => undefined}
        loading={locations.loading}
        error={locations.error}
        exportName="cash-locations"
        actions={(l) => (
          <>
            {auth.can('gl.cash_location.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setLocForm({
                    editing: l,
                    name: l.name,
                    kind: l.kind,
                    accountId: l.accountId,
                    currency: l.currency,
                  });
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('gl.cash_location.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving({
                    path: `/cash-locations/${l.id}`,
                    version: l.version,
                    label: l.name,
                  });
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />

      <h2>{t('bank.accounts')}</h2>
      {auth.can('gl.bank_account.create') && bankLocations.length > 0 ? (
        <Button
          icon={Plus}
          onClick={() => {
            setBankForm({
              editing: null,
              cashLocationId: bankLocations[0]?.id ?? '',
              bankName: '',
              iban: '',
              wpsEmployerId: '',
            });
          }}
        >
          {t('bank.newAccount')}
        </Button>
      ) : null}
      <DataTable
        columns={[
          { key: 'bank', header: t('bank.bankName'), value: (a: BankAccountRow) => a.bankName },
          {
            key: 'location',
            header: t('bank.location'),
            value: (a) => locationName(a.cashLocationId),
          },
          { key: 'iban', header: t('bank.iban'), value: (a) => a.ibanMasked },
          { key: 'wps', header: t('bank.wps'), value: (a) => a.wpsEmployerId ?? '' },
        ]}
        rows={accounts.rows}
        rowKey={(a) => a.id}
        total={accounts.total}
        page={1}
        pageSize={Math.max(accounts.rows.length, 1)}
        onPageChange={() => undefined}
        loading={accounts.loading}
        error={accounts.error}
        exportName="company-bank-accounts"
        actions={(a) => (
          <>
            {auth.can('gl.bank_account.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setBankForm({
                    editing: a,
                    cashLocationId: a.cashLocationId,
                    bankName: a.bankName,
                    iban: '',
                    wpsEmployerId: a.wpsEmployerId ?? '',
                  });
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('gl.bank_account.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving({
                    path: `/company-bank-accounts/${a.id}`,
                    version: a.version,
                    label: a.bankName,
                  });
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />

      <ModalForm
        open={locForm !== null}
        title={locForm?.editing ? t('bank.editLocation') : t('bank.newLocation')}
        submitLabel={t('common.save')}
        onClose={() => {
          setLocForm(null);
        }}
        onSubmit={saveLocation}
      >
        {locForm === null ? null : (
          <>
            <Field
              label={t('gl.name')}
              required
              value={locForm.name}
              onChange={(e) => {
                setLocForm({ ...locForm, name: e.target.value });
              }}
            />
            <Select
              label={t('bank.kind')}
              disabled={locForm.editing !== null}
              options={KINDS.map((k) => ({ value: k, label: t(`bank.kind.${k}`) }))}
              value={locForm.kind}
              onChange={(e) => {
                setLocForm({ ...locForm, kind: e.target.value });
              }}
            />
            <Select
              label={t('gl.account')}
              hint={t('bank.accountHint')}
              placeholder={t('bank.choose')}
              options={assetAccounts.map((a) => ({
                value: a.id,
                label: accountLabel(tree, a.id, language),
              }))}
              value={locForm.accountId}
              onChange={(e) => {
                setLocForm({ ...locForm, accountId: e.target.value });
              }}
            />
            <Field
              label={t('gl.currency')}
              maxLength={3}
              disabled={locForm.editing !== null}
              value={locForm.currency}
              onChange={(e) => {
                setLocForm({ ...locForm, currency: e.target.value });
              }}
            />
          </>
        )}
      </ModalForm>

      <ModalForm
        open={bankForm !== null}
        title={bankForm?.editing ? t('bank.editAccount') : t('bank.newAccount')}
        submitLabel={t('common.save')}
        onClose={() => {
          setBankForm(null);
        }}
        onSubmit={saveBank}
      >
        {bankForm === null ? null : (
          <>
            <Select
              label={t('bank.location')}
              disabled={bankForm.editing !== null}
              options={bankLocations.map((l) => ({ value: l.id, label: l.name }))}
              value={bankForm.cashLocationId}
              onChange={(e) => {
                setBankForm({ ...bankForm, cashLocationId: e.target.value });
              }}
            />
            <Field
              label={t('bank.bankName')}
              required
              value={bankForm.bankName}
              onChange={(e) => {
                setBankForm({ ...bankForm, bankName: e.target.value });
              }}
            />
            <Field
              label={t('bank.iban')}
              hint={bankForm.editing === null ? t('bank.ibanHint') : t('bank.ibanKeepHint')}
              required={bankForm.editing === null}
              autoComplete="off"
              spellCheck={false}
              value={bankForm.iban}
              onChange={(e) => {
                setBankForm({ ...bankForm, iban: e.target.value });
              }}
            />
            <Field
              label={t('bank.wps')}
              value={bankForm.wpsEmployerId}
              onChange={(e) => {
                setBankForm({ ...bankForm, wpsEmployerId: e.target.value });
              }}
            />
          </>
        )}
      </ModalForm>

      <ReasonDialog
        open={removing !== null}
        title={t('common.delete')}
        hint={removing === null ? undefined : t('bank.deleteHint', { name: removing.label })}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={(reason) => {
          if (removing === null) return;
          const target = removing;
          setRemoving(null);
          api(target.path, {
            method: 'DELETE',
            body: { reason },
            headers: ifMatch(target.version),
          })
            .then(() => {
              locations.reload();
              accounts.reload();
            })
            .catch(fail);
        }}
      />
    </>
  );
}
