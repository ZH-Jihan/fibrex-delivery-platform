/**
 * Sync sources (phase 4 row 4.4): the list of platform reports the sync engine reads, and
 * the create/edit form (platform, name, kind, spreadsheet id or URL, tab, schedule, time
 * zone, on/off) with "Test headers" for a saved Google Sheet source.
 *
 * Rules, and why:
 *   - The form is checked by the shared `syncSourceFormSchema` before saving; the API checks
 *     again. A pasted browser URL is fine: the API keeps only the spreadsheet id.
 *   - Edits send the version that was loaded; a 409 means someone else saved first.
 *   - The column mapping editor, runs, unmatched queue and Excel upload screens are row 4.5.
 *
 * Depends on: api client, auth, i18n, ui components, toast, @fibrex/shared, ./GoogleConnectionPage
 * (header test result). Used by: App.tsx (route /performance/sync-sources).
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Save, Sheet } from 'lucide-react';
import { syncSourceFormSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../ui/components';
import { useToast } from '../ui/toast';
import { HeaderTestResult, type HeaderTest } from './GoogleConnectionPage';

export interface SyncSourceItem {
  id: string;
  clientPlatformId: string;
  platformName: string;
  name: string;
  adapterKind: string;
  spreadsheetId: string | null;
  tab: string;
  scheduleCron: string;
  timeZone: string;
  active: boolean;
  version: number;
}

interface Platform {
  id: string;
  name: string;
}

interface FormState {
  clientPlatformId: string;
  name: string;
  adapterKind: 'sheet' | 'excel';
  spreadsheet: string;
  tab: string;
  scheduleCron: string;
  timeZone: string;
  active: boolean;
}

const EMPTY: FormState = {
  clientPlatformId: '',
  name: '',
  adapterKind: 'sheet',
  spreadsheet: '',
  tab: 'Daily Report',
  scheduleCron: '0 4 * * *',
  timeZone: 'Asia/Qatar',
  active: true,
};

export function SyncSourcesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canCreate = auth.can('performance.sync_source.create');
  const canEdit = auth.can('performance.sync_source.update');
  const [items, setItems] = useState<SyncSourceItem[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<SyncSourceItem | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [tests, setTests] = useState<Record<string, HeaderTest>>({});

  const load = useCallback(() => {
    api<{ items: SyncSourceItem[] }>('/sync-sources')
      .then((r) => {
        setItems(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);

  useEffect(() => {
    load();
    api<{ items: Platform[] }>('/client-platforms')
      .then((r) => {
        setPlatforms(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [load]);

  const open = (item: SyncSourceItem | 'new') => {
    setIssues({});
    setFormError(null);
    setEditing(item);
    setForm(
      item === 'new'
        ? { ...EMPTY, clientPlatformId: platforms[0]?.id ?? '' }
        : {
            clientPlatformId: item.clientPlatformId,
            name: item.name,
            adapterKind: item.adapterKind === 'excel' ? 'excel' : 'sheet',
            spreadsheet: item.spreadsheetId ?? '',
            tab: item.tab,
            scheduleCron: item.scheduleCron,
            timeZone: item.timeZone,
            active: item.active,
          },
    );
  };

  const save = () => {
    const parsed = syncSourceFormSchema.safeParse(form);
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setIssues(found);
      return;
    }
    setIssues({});
    const request =
      editing === 'new'
        ? api<SyncSourceItem>('/sync-sources', { method: 'POST', body: parsed.data })
        : api<SyncSourceItem>(`/sync-sources/${editing?.id ?? ''}`, {
            method: 'PUT',
            body: { ...parsed.data, version: editing?.version },
          });
    request
      .then(() => {
        toast.show(t('syncSource.saved'), 'success');
        setEditing(null);
        load();
      })
      .catch((e: unknown) => {
        setFormError(e);
      });
  };

  const testHeaders = (id: string) => {
    api<HeaderTest>(`/sync-sources/${id}/test-headers`, { method: 'POST' })
      .then((r) => {
        setTests((all) => ({ ...all, [id]: r }));
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <div>
      <PageHeader
        title={t('syncSource.title')}
        icon={RefreshCw}
        description={t('syncSource.intro')}
        actions={
          canCreate ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                open('new');
              }}
            >
              {t('syncSource.add')}
            </Button>
          ) : null
        }
      />
      <ErrorAlert error={error} />
      {items === null ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <EmptyState title={t('syncSource.none')} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('syncSource.name')}</th>
              <th>{t('syncSource.platform')}</th>
              <th>{t('syncSource.kind')}</th>
              <th>{t('syncSource.tab')}</th>
              <th>{t('syncSource.schedule')}</th>
              <th>{t('syncSource.active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}
                  {tests[s.id] !== undefined ? (
                    <HeaderTestResult result={tests[s.id] ?? null} />
                  ) : null}
                </td>
                <td>{s.platformName}</td>
                <td>
                  {t(s.adapterKind === 'sheet' ? 'syncSource.kind.sheet' : 'syncSource.kind.excel')}
                </td>
                <td>{s.adapterKind === 'sheet' ? s.tab : '—'}</td>
                <td>
                  {s.adapterKind === 'sheet'
                    ? `${s.scheduleCron} (${s.timeZone})`
                    : t('syncSource.uploadOnly')}
                </td>
                <td>
                  <Pill tone={s.active ? 'success' : 'neutral'}>
                    {t(s.active ? 'syncSource.on' : 'syncSource.off')}
                  </Pill>
                </td>
                <td>
                  {canEdit && s.adapterKind === 'sheet' ? (
                    <Button
                      size="sm"
                      icon={Sheet}
                      onClick={() => {
                        testHeaders(s.id);
                      }}
                    >
                      {t('syncSource.testHeaders')}
                    </Button>
                  ) : null}
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Pencil}
                      aria-label={t('syncSource.edit', { name: s.name })}
                      onClick={() => {
                        open(s);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        aria-labelledby="sync-source-form"
      >
        <h2 id="sync-source-form">
          {editing === 'new' ? t('syncSource.add') : t('syncSource.editTitle')}
        </h2>
        <ErrorAlert error={formError} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Select
            label={t('syncSource.platform')}
            value={form.clientPlatformId}
            options={platforms.map((p) => ({ value: p.id, label: p.name }))}
            placeholder={t('common.choose')}
            error={issues.clientPlatformId}
            onChange={(e) => {
              set('clientPlatformId', e.target.value);
            }}
          />
          <Field
            label={t('syncSource.name')}
            value={form.name}
            error={issues.name}
            onChange={(e) => {
              set('name', e.target.value);
            }}
          />
          <Select
            label={t('syncSource.kind')}
            value={form.adapterKind}
            options={[
              { value: 'sheet', label: t('syncSource.kind.sheet') },
              { value: 'excel', label: t('syncSource.kind.excel') },
            ]}
            onChange={(e) => {
              set('adapterKind', e.target.value === 'excel' ? 'excel' : 'sheet');
            }}
          />
          {form.adapterKind === 'sheet' ? (
            <>
              <Field
                label={t('syncSource.spreadsheet')}
                value={form.spreadsheet}
                hint={t('syncSource.spreadsheetHint')}
                error={issues.spreadsheet}
                onChange={(e) => {
                  set('spreadsheet', e.target.value);
                }}
              />
              <Field
                label={t('syncSource.tab')}
                value={form.tab}
                error={issues.tab}
                onChange={(e) => {
                  set('tab', e.target.value);
                }}
              />
              <Field
                label={t('syncSource.schedule')}
                value={form.scheduleCron}
                hint={t('syncSource.scheduleHint')}
                error={issues.scheduleCron}
                onChange={(e) => {
                  set('scheduleCron', e.target.value);
                }}
              />
              <Field
                label={t('syncSource.timeZone')}
                value={form.timeZone}
                error={issues.timeZone}
                onChange={(e) => {
                  set('timeZone', e.target.value);
                }}
              />
            </>
          ) : (
            <p className="muted">{t('syncSource.excelHelp')}</p>
          )}
          <Checkbox
            label={t('syncSource.active')}
            checked={form.active}
            onChange={(e) => {
              set('active', e.target.checked);
            }}
          />
          <div className="dialog-actions">
            <Button
              onClick={() => {
                setEditing(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" icon={Save}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
