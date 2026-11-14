/**
 * Memberships tab of a user: which companies the user belongs to, with which roles, and which
 * company is the default. Without a membership a user cannot sign in to anything.
 * The whole list is saved at once (PUT /users/{id}/memberships); the API enforces the rules
 * (one entry per company, exactly one default, only roles the editor may give out) and
 * ends the user's sessions after a change. Needs a recent password check (useReauth).
 * Companies offered are those the editor belongs to (GET /me/companies).
 * Depends on: api client, useReauth, i18n, ui. Used by: UsersPage (user detail).
 */
import { useEffect, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Select, Skeleton } from '../ui/components';
import { useReauth } from '../ui/useReauth';
import { useToast } from '../ui/toast';

interface Membership {
  companyId: string;
  roleIds: string[];
  isDefault: boolean;
  status: 'active' | 'suspended';
}
interface Company {
  id: string;
  name: string;
}
interface Role {
  id: string;
  name: string;
}

export function MembershipsTab({ userId }: { userId: string }) {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const reauth = useReauth();
  const [rows, setRows] = useState<Membership[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<unknown>(null);
  const canEdit = auth.can('iam.user.manage_access');

  useEffect(() => {
    Promise.all([
      api<{ memberships: Membership[] }>(`/users/${userId}/memberships`),
      api<{ items: Company[] }>('/me/companies'),
      api<{ items: Role[] }>('/roles', { query: { page: 1, pageSize: 100 } }),
    ])
      .then(([m, c, r]) => {
        setRows(m.memberships);
        setCompanies(c.items);
        setRoles(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [userId]);

  if (rows === null) return error === null ? <Skeleton lines={3} /> : <ErrorAlert error={error} />;

  const update = (index: number, patch: Partial<Membership>) => {
    setRows(rows.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };
  const makeDefault = (index: number) => {
    setRows(rows.map((m, i) => ({ ...m, isDefault: i === index })));
  };
  const used = new Set(rows.map((m) => m.companyId));
  const free = companies.filter((c) => !used.has(c.id));
  const nameOf = (id: string) => companies.find((c) => c.id === id)?.name ?? id;

  const add = () => {
    const company = free[0];
    if (company === undefined) return;
    setRows([
      ...rows,
      { companyId: company.id, roleIds: [], isDefault: rows.length === 0, status: 'active' },
    ]);
  };
  const remove = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    // The API wants exactly one default when any entry remains.
    setRows(
      next.length > 0 && !next.some((m) => m.isDefault)
        ? next.map((m, i) => (i === 0 ? { ...m, isDefault: true } : m))
        : next,
    );
  };
  const save = () => {
    setError(null);
    reauth
      .run(() =>
        api<{ memberships: Membership[] }>(`/users/${userId}/memberships`, {
          method: 'PUT',
          body: { memberships: rows },
        }),
      )
      .then((r) => {
        setRows(r.memberships);
        toast.show(t('users.done'), 'success');
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  return (
    <section>
      <ErrorAlert error={error} />
      {rows.length === 0 ? <p>{t('memberships.none')}</p> : null}
      {rows.map((m, i) => (
        <fieldset key={m.companyId} className="card" data-testid="membership">
          <legend>{nameOf(m.companyId)}</legend>
          <Select
            label={t('memberships.status')}
            value={m.status}
            disabled={!canEdit}
            options={[
              { value: 'active', label: 'active' },
              { value: 'suspended', label: 'suspended' },
            ]}
            onChange={(e) => {
              update(i, { status: e.target.value as Membership['status'] });
            }}
          />
          <Checkbox
            type="radio"
            name="default-company"
            label={t('memberships.default')}
            checked={m.isDefault}
            disabled={!canEdit}
            onChange={() => {
              makeDefault(i);
            }}
          />
          <div role="group" aria-label={t('memberships.roles')} className="check-list">
            {roles.map((r) => (
              <Checkbox
                key={r.id}
                label={r.name}
                checked={m.roleIds.includes(r.id)}
                disabled={!canEdit}
                onChange={(e) => {
                  update(i, {
                    roleIds: e.target.checked
                      ? [...m.roleIds, r.id]
                      : m.roleIds.filter((x) => x !== r.id),
                  });
                }}
              />
            ))}
          </div>
          {canEdit ? (
            <Button
              variant="link"
              dangerText
              icon={Trash2}
              onClick={() => {
                remove(i);
              }}
            >
              {t('memberships.remove')}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {canEdit ? (
        <div className="row-actions">
          <Button icon={Plus} onClick={add} disabled={free.length === 0}>
            {t('memberships.add')}
          </Button>
          <Button variant="primary" icon={Check} onClick={save}>
            {t('common.save')}
          </Button>
        </div>
      ) : null}
      {reauth.dialog}
    </section>
  );
}
