/**
 * Template editor screen (phase 2 row 2.7b): letters, slips, e-mails and messages the
 * business words itself, with `{{merge fields}}`.
 *
 * Flow: pick or create a template (key, kind, name) -> its versions (one list per template,
 * served flat as `/template-versions?templateId=`) -> open a version in the editor. A draft
 * can be edited, previewed with sample data and published; a published version is frozen
 * (shown read-only: make a new version to change it). The preview is the server's own
 * rendering (same engine as the PDF), shown in a sandboxed frame with scripts off.
 * The key and kind of a template never change once created: other modules look it up by key.
 *
 * Depends on: api client, auth, i18n, ui components. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Eye, FileText, Pencil, Plus, Rocket, Save, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Select, Textarea } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

const KINDS = ['pdf', 'email', 'whatsapp', 'sms', 'push'] as const;
const PAPERS = ['A4', 'A5', 'Letter'] as const;

interface TemplateRow {
  id: string;
  key: string;
  kind: (typeof KINDS)[number];
  name: string;
  version: number;
}
interface VersionRow {
  id: string;
  templateId: string;
  language: string;
  versionNo: number;
  subject: string | null;
  body: string;
  css: string;
  paper: (typeof PAPERS)[number];
  status: 'draft' | 'published' | 'retired';
  validFrom: string;
  version: number;
}
interface Preview {
  subject: string | null;
  body: string;
  html: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });
const KEY_PATTERN = /^[a-z][a-z0-9_.]{0,59}$/;
export const SAMPLE_DATA = '{\n  "name": "Asha Rahman",\n  "amount": "1,250.00"\n}';

/** Parses the sample-data box: a JSON object, or a message when it is not one. */
export function parseSample(text: string): { data: Record<string, unknown> } | { problem: true } {
  try {
    const value: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { data: value as Record<string, unknown> };
    }
  } catch {
    // falls through to the problem result
  }
  return { problem: true };
}

export function TemplatesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [draftTemplate, setDraftTemplate] = useState({ key: '', name: '', kind: 'pdf' });
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<TemplateRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [newLanguage, setNewLanguage] = useState('en');
  const [open, setOpen] = useState<VersionRow | null>(null);
  const [edit, setEdit] = useState({ subject: '', body: '', css: '', paper: 'A4' });
  const [sample, setSample] = useState(SAMPLE_DATA);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [removing, setRemoving] = useState<VersionRow | null>(null);
  const [reason, setReason] = useState('');

  const loadTemplates = useCallback(() => {
    setLoading(true);
    api<{ items: TemplateRow[] }>('/templates', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setTemplates(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadTemplates, [loadTemplates]);

  const loadVersions = useCallback((template: TemplateRow | null) => {
    if (template === null) {
      setVersions([]);
      return;
    }
    api<{ items: VersionRow[] }>('/template-versions', {
      query: { templateId: template.id, page: 1, pageSize: 200 },
    })
      .then((r) => {
        setVersions(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(() => {
    loadVersions(selected);
  }, [selected, loadVersions]);

  const openVersion = (v: VersionRow) => {
    setOpen(v);
    setEdit({ subject: v.subject ?? '', body: v.body, css: v.css, paper: v.paper });
    setPreview(null);
    setFormProblem(null);
  };

  const run = (job: Promise<unknown>, after?: () => void) => {
    job
      .then(() => {
        setError(null);
        after?.();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const createTemplate = () => {
    if (!KEY_PATTERN.test(draftTemplate.key) || draftTemplate.name.trim() === '') {
      setFormProblem(t('templates.keyHint'));
      return;
    }
    run(
      api('/templates', {
        method: 'POST',
        body: { key: draftTemplate.key, kind: draftTemplate.kind, name: draftTemplate.name.trim() },
      }),
      () => {
        setCreating(false);
        setFormProblem(null);
        setDraftTemplate({ key: '', name: '', kind: 'pdf' });
        loadTemplates();
      },
    );
  };

  const createVersion = () => {
    if (selected === null) return;
    const starter = selected.kind === 'pdf' ? '<h1>Hello {{name}}</h1>' : 'Hello {{name}}';
    api<VersionRow>('/template-versions', {
      method: 'POST',
      body: { templateId: selected.id, language: newLanguage.trim(), body: starter },
    })
      .then((v) => {
        setError(null);
        loadVersions(selected);
        openVersion(v);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  /** Saves the draft (if it is one), then asks the server to render it with the sample data. */
  const saveAndPreview = async (saveFirst: boolean) => {
    if (open === null) return;
    const parsed = parseSample(sample);
    if ('problem' in parsed) {
      setFormProblem(t('templates.sampleProblem'));
      return;
    }
    setFormProblem(null);
    try {
      let current = open;
      if (saveFirst && open.status === 'draft') {
        current = await api<VersionRow>(`/template-versions/${open.id}`, {
          method: 'PATCH',
          headers: ifMatch(open.version),
          body: {
            subject: edit.subject.trim() === '' ? null : edit.subject,
            body: edit.body,
            css: edit.css,
            paper: edit.paper,
          },
        });
        setOpen(current);
        loadVersions(selected);
      }
      setPreview(
        await api<Preview>(`/template-versions/${current.id}/preview`, {
          method: 'POST',
          body: { data: parsed.data },
        }),
      );
      setError(null);
    } catch (e: unknown) {
      setError(e);
    }
  };

  const publish = (v: VersionRow) => {
    run(
      api(`/template-versions/${v.id}/publish`, { method: 'POST', headers: ifMatch(v.version) }),
      () => {
        loadVersions(selected);
        setOpen(null);
      },
    );
  };

  const frozen = open !== null && open.status !== 'draft';
  const isPdf = selected?.kind === 'pdf';
  const statusText = (s: VersionRow['status']) => t(`templates.status.${s}`);

  return (
    <>
      <PageHeader
        title={t('templates.title')}
        icon={FileText}
        description={t('templates.intro')}
        actions={
          auth.can('platform.template.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('templates.new')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('templates.new')}>
          <Field
            label={t('templates.key')}
            hint={t('templates.keyHint')}
            value={draftTemplate.key}
            onChange={(e) => {
              setDraftTemplate({ ...draftTemplate, key: e.target.value });
            }}
          />
          <Field
            label={t('templates.name')}
            value={draftTemplate.name}
            onChange={(e) => {
              setDraftTemplate({ ...draftTemplate, name: e.target.value });
            }}
          />
          <Select
            label={t('templates.kind')}
            value={draftTemplate.kind}
            options={KINDS.map((k) => ({ value: k, label: t(`templates.kind.${k}`) }))}
            onChange={(e) => {
              setDraftTemplate({ ...draftTemplate, kind: e.target.value });
            }}
          />
          {formProblem === null ? null : (
            <p className="field-error" role="alert">
              {formProblem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={createTemplate}>
            {t('common.save')}
          </Button>
          <Button
            onClick={() => {
              setCreating(false);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('templates.key'), value: (r) => r.key },
          { key: 'name', header: t('templates.name'), value: (r) => r.name },
          { key: 'kind', header: t('templates.kind'), value: (r) => t(`templates.kind.${r.kind}`) },
        ]}
        rows={templates}
        rowKey={(r) => r.id}
        total={templates.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="templates"
        actions={(r) => (
          <Button
            variant="link"
            icon={Pencil}
            onClick={() => {
              setSelected(r);
              setOpen(null);
              setPreview(null);
            }}
          >
            {t('templates.versions')}
          </Button>
        )}
      />
      {selected !== null ? (
        <section className="card" aria-label={t('templates.versionsOf', { name: selected.key })}>
          <h2>{t('templates.versionsOf', { name: selected.key })}</h2>
          {auth.can('platform.template_version.create') ? (
            <>
              <Field
                label={t('templates.language')}
                hint={t('templates.languageHint')}
                value={newLanguage}
                onChange={(e) => {
                  setNewLanguage(e.target.value);
                }}
              />
              <Button variant="primary" icon={Plus} onClick={createVersion}>
                {t('templates.newVersion')}
              </Button>
            </>
          ) : null}
          <DataTable
            columns={[
              { key: 'language', header: t('templates.language'), value: (r) => r.language },
              { key: 'no', header: t('templates.number'), value: (r) => String(r.versionNo) },
              {
                key: 'status',
                header: t('templates.statusCol'),
                value: (r) => statusText(r.status),
              },
              { key: 'from', header: t('templates.validFrom'), value: (r) => r.validFrom },
            ]}
            rows={versions}
            rowKey={(r) => r.id}
            total={versions.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="template-versions"
            actions={(r) => (
              <>
                <Button
                  variant="link"
                  icon={r.status === 'draft' ? Pencil : Eye}
                  onClick={() => {
                    openVersion(r);
                  }}
                >
                  {r.status === 'draft' ? t('common.edit') : t('templates.view')}
                </Button>
                {r.status === 'draft' && auth.can('platform.template_version.publish') ? (
                  <Button
                    variant="link"
                    icon={Rocket}
                    onClick={() => {
                      publish(r);
                    }}
                  >
                    {t('templates.publish')}
                  </Button>
                ) : null}
                {r.status === 'draft' && auth.can('platform.template_version.delete') ? (
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
        </section>
      ) : null}
      {open !== null && selected !== null ? (
        <section
          className="card"
          aria-label={t('templates.editorOf', {
            language: open.language,
            no: String(open.versionNo),
          })}
        >
          <h2>
            {t('templates.editorOf', { language: open.language, no: String(open.versionNo) })}
          </h2>
          {frozen ? <p className="muted">{t('templates.frozen')}</p> : null}
          {isPdf ? null : (
            <Field
              label={t('templates.subject')}
              value={edit.subject}
              readOnly={frozen}
              onChange={(e) => {
                setEdit({ ...edit, subject: e.target.value });
              }}
            />
          )}
          <Textarea
            label={t('templates.body')}
            hint={t('templates.bodyHint')}
            rows={12}
            value={edit.body}
            readOnly={frozen}
            onChange={(e) => {
              setEdit({ ...edit, body: e.target.value });
            }}
          />
          {isPdf ? (
            <>
              <Textarea
                label={t('templates.css')}
                rows={4}
                value={edit.css}
                readOnly={frozen}
                onChange={(e) => {
                  setEdit({ ...edit, css: e.target.value });
                }}
              />
              <Select
                label={t('templates.paper')}
                value={edit.paper}
                disabled={frozen}
                options={PAPERS.map((p) => ({ value: p, label: p }))}
                onChange={(e) => {
                  setEdit({ ...edit, paper: e.target.value });
                }}
              />
            </>
          ) : null}
          <Textarea
            label={t('templates.sample')}
            hint={t('templates.sampleHint')}
            rows={6}
            value={sample}
            onChange={(e) => {
              setSample(e.target.value);
            }}
          />
          {formProblem === null ? null : (
            <p className="field-error" role="alert">
              {formProblem}
            </p>
          )}
          {auth.can('platform.template_version.preview') ? (
            <Button
              variant="primary"
              icon={Eye}
              onClick={() => {
                void saveAndPreview(true);
              }}
            >
              {frozen ? t('templates.preview') : t('templates.saveAndPreview')}
            </Button>
          ) : null}
          {preview === null ? null : (
            <div aria-label={t('templates.previewArea')} role="region">
              {preview.subject === null ? null : <p>{preview.subject}</p>}
              {/* Scripts off, no same-origin access: the template's HTML cannot touch the app. */}
              <iframe
                title={t('templates.previewArea')}
                sandbox=""
                srcDoc={preview.html}
                style={{ width: '100%', height: '28rem', border: '1px solid var(--border, #ccc)' }}
              />
            </div>
          )}
        </section>
      ) : null}
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
          run(
            api(`/template-versions/${target.id}`, {
              method: 'DELETE',
              body: { reason: reason.trim() },
              headers: ifMatch(target.version),
            }),
            () => {
              if (open?.id === target.id) setOpen(null);
              loadVersions(selected);
            },
          );
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
