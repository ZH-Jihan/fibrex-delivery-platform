/**
 * Match rules screen (phase 2 row 2.17b; PLAN 3.9 `bank_match_rule`).
 *
 * Rules tell auto-matching how to read a bank line: which lines the rule applies to
 * (direction, text in the reference or description, amount range, date window) and, as an
 * option, that the ledger entry must also touch a counter account. They are tried in priority
 * order (lowest number first); a rule never forces a match, it only narrows the search, and the
 * server still matches only when exactly one ledger line qualifies. Rules are data (SPEC 2.6).
 * Not built: choosing a party as the target (the API supports it; the screen needs a party
 * picker).
 *
 * Depends on: api client, auth, i18n, ui, bank-ui, ledger-utils. Used by: App.tsx routes.
 */
import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import type { MatchConditions } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Field, PageHeader, Pill, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { ifMatch, ModalForm, ReasonDialog, useApiList } from './bank-ui';
import { accountLabel, flattenTree, type AccountNode, type FlatAccount } from './ledger-utils';

export interface RuleRow {
  id: string;
  name: string;
  conditions: MatchConditions;
  targetAccountId: string | null;
  priority: number;
  active: boolean;
  version: number;
}

interface RuleForm {
  editing: RuleRow | null;
  name: string;
  direction: string;
  textContains: string;
  amountMin: string;
  amountMax: string;
  dateWindowDays: string;
  targetAccountId: string;
  priority: string;
  active: boolean;
}

/** The conditions object the API expects: only what was filled in. */
export function buildConditions(
  form: Pick<RuleForm, 'direction' | 'textContains' | 'amountMin' | 'amountMax' | 'dateWindowDays'>,
): MatchConditions {
  const out: MatchConditions = {};
  if (form.direction === 'in' || form.direction === 'out') out.direction = form.direction;
  if (form.textContains.trim() !== '') out.textContains = form.textContains.trim();
  if (form.amountMin.trim() !== '') out.amountMin = form.amountMin.trim();
  if (form.amountMax.trim() !== '') out.amountMax = form.amountMax.trim();
  if (form.dateWindowDays.trim() !== '') out.dateWindowDays = Number(form.dateWindowDays);
  return out;
}

export function MatchRulesPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const list = useApiList<RuleRow>('/bank-match-rules', { pageSize: 200 });
  const [tree, setTree] = useState<FlatAccount[]>([]);
  const [form, setForm] = useState<RuleForm | null>(null);
  const [removing, setRemoving] = useState<RuleRow | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!auth.can('gl.account.read')) return;
    api<{ items: AccountNode[] }>('/accounts/tree')
      .then((r) => {
        setTree(flattenTree(r.items));
      })
      .catch(() => undefined);
  }, [auth]);

  const open = (rule: RuleRow | null) => {
    const c = rule?.conditions ?? {};
    setForm({
      editing: rule,
      name: rule?.name ?? '',
      direction: c.direction ?? '',
      textContains: c.textContains ?? '',
      amountMin: c.amountMin ?? '',
      amountMax: c.amountMax ?? '',
      dateWindowDays: c.dateWindowDays === undefined ? '' : String(c.dateWindowDays),
      targetAccountId: rule?.targetAccountId ?? '',
      priority: String(rule?.priority ?? 100),
      active: rule?.active ?? true,
    });
  };

  const save = () => {
    if (form === null) return;
    const f = form;
    const body = {
      name: f.name.trim(),
      conditions: buildConditions(f),
      targetAccountId: f.targetAccountId === '' ? null : f.targetAccountId,
      priority: Number(f.priority),
      active: f.active,
    };
    const request = f.editing
      ? api(`/bank-match-rules/${f.editing.id}`, {
          method: 'PATCH',
          headers: ifMatch(f.editing.version),
          body,
        })
      : api('/bank-match-rules', { method: 'POST', body });
    request
      .then(() => {
        setForm(null);
        setError(null);
        list.reload();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const summary = (r: RuleRow) => {
    const c = r.conditions;
    const parts: string[] = [];
    if (c.direction !== undefined) parts.push(t(`bank.direction.${c.direction}`));
    if (c.textContains !== undefined) parts.push(`"${c.textContains}"`);
    if (c.amountMin !== undefined || c.amountMax !== undefined) {
      parts.push(`${c.amountMin ?? '0'} – ${c.amountMax ?? '∞'}`);
    }
    if (c.dateWindowDays !== undefined) parts.push(t('bank.days', { days: c.dateWindowDays }));
    return parts.join(' · ');
  };

  return (
    <>
      <PageHeader
        title={t('bank.rulesTitle')}
        icon={Wand2}
        description={t('bank.rulesIntro')}
        actions={
          auth.can('gl.bank_match_rule.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                open(null);
              }}
            >
              {t('bank.newRule')}
            </Button>
          ) : null
        }
      />
      {error !== null ? <ErrorAlert error={error} /> : null}
      <DataTable
        columns={[
          { key: 'priority', header: t('bank.priority'), value: (r: RuleRow) => r.priority },
          { key: 'name', header: t('gl.name'), value: (r) => r.name },
          { key: 'when', header: t('bank.when'), value: summary },
          {
            key: 'target',
            header: t('bank.targetAccount'),
            value: (r) =>
              r.targetAccountId === null ? '' : accountLabel(tree, r.targetAccountId, language),
          },
          {
            key: 'active',
            header: t('gl.state'),
            value: (r) => (r.active ? t('bank.active') : t('bank.inactive')),
            render: (r) => (
              <Pill tone={r.active ? 'success' : 'neutral'}>
                {r.active ? t('bank.active') : t('bank.inactive')}
              </Pill>
            ),
          },
        ]}
        rows={list.rows}
        rowKey={(r) => r.id}
        total={list.total}
        page={1}
        pageSize={Math.max(list.rows.length, 1)}
        onPageChange={() => undefined}
        loading={list.loading}
        error={list.error}
        exportName="bank-match-rules"
        actions={(r) => (
          <>
            {auth.can('gl.bank_match_rule.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  open(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('gl.bank_match_rule.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving(r);
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
        title={form?.editing ? t('bank.editRule') : t('bank.newRule')}
        submitLabel={t('common.save')}
        onClose={() => {
          setForm(null);
        }}
        onSubmit={save}
      >
        {form === null ? null : (
          <>
            <Field
              label={t('gl.name')}
              required
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
              }}
            />
            <Select
              label={t('bank.direction')}
              placeholder={t('rep.any')}
              options={[
                { value: 'in', label: t('bank.direction.in') },
                { value: 'out', label: t('bank.direction.out') },
              ]}
              value={form.direction}
              onChange={(e) => {
                setForm({ ...form, direction: e.target.value });
              }}
            />
            <Field
              label={t('bank.textContains')}
              hint={t('bank.textContainsHint')}
              value={form.textContains}
              onChange={(e) => {
                setForm({ ...form, textContains: e.target.value });
              }}
            />
            <Field
              label={t('bank.amountMin')}
              inputMode="decimal"
              value={form.amountMin}
              onChange={(e) => {
                setForm({ ...form, amountMin: e.target.value });
              }}
            />
            <Field
              label={t('bank.amountMax')}
              inputMode="decimal"
              value={form.amountMax}
              onChange={(e) => {
                setForm({ ...form, amountMax: e.target.value });
              }}
            />
            <Field
              label={t('bank.window')}
              hint={t('bank.windowHint')}
              type="number"
              min={0}
              max={30}
              value={form.dateWindowDays}
              onChange={(e) => {
                setForm({ ...form, dateWindowDays: e.target.value });
              }}
            />
            <Select
              label={t('bank.targetAccount')}
              hint={t('bank.targetAccountHint')}
              placeholder={t('rep.any')}
              options={tree
                .filter((a) => a.isPostable)
                .map((a) => ({ value: a.id, label: accountLabel(tree, a.id, language) }))}
              value={form.targetAccountId}
              onChange={(e) => {
                setForm({ ...form, targetAccountId: e.target.value });
              }}
            />
            <Field
              label={t('bank.priority')}
              hint={t('bank.priorityHint')}
              type="number"
              min={0}
              max={9999}
              value={form.priority}
              onChange={(e) => {
                setForm({ ...form, priority: e.target.value });
              }}
            />
            <Checkbox
              label={t('bank.active')}
              checked={form.active}
              onChange={(e) => {
                setForm({ ...form, active: e.target.checked });
              }}
            />
          </>
        )}
      </ModalForm>

      <ReasonDialog
        open={removing !== null}
        title={t('common.delete')}
        hint={removing === null ? undefined : t('bank.deleteHint', { name: removing.name })}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={(reason) => {
          if (removing === null) return;
          const target = removing;
          setRemoving(null);
          api(`/bank-match-rules/${target.id}`, {
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
