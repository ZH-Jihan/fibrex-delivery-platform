/**
 * Employee profile page (phase 3 row 3.3b), at /employees/:id.
 *
 * Tabs: Profile (details and bank accounts), Documents (with "Add other document" and scans),
 * Placement (placements and employment periods) and History (audit trail).
 *
 * Rules, and why:
 *   - Document numbers arrive masked; the page never asks for the real number (reveal is a
 *     separate, audited permission and is not offered here).
 *   - "Add other document" creates a custom document with a typed name instead of a type, for
 *     papers no standard type covers (SPEC 3.2); the API enforces type-or-name, not both.
 *   - A single-page document type takes a new scan as a new version of its one page, so the
 *     page sends `replacesAttachmentId` after a 409 `single_page_document` (the API tells us
 *     which page to replace).
 *   - Bank accounts: whoever adds or changes an account is its requester and can never approve
 *     it. The Approve button is therefore hidden for the requester and replaced by a note; the
 *     API and the database refuse it too. Payment uses only approved ("verified") accounts.
 *   - Only the last digits of an account number are shown.
 *   - "Scan to fill in" (row 3.6) reads a scan with OCR and opens a confirm panel
 *     (./OcrScan.tsx); the document is saved only when the person confirms.
 *
 * Depends on: api client, auth, i18n, ui (components, EntityForm, HistoryTab, toast),
 * data/upload, ./OcrScan.tsx, @fibrex/shared (documents, bank account form). Used by: App.tsx
 * route.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, FilePlus, Landmark, ScanText, Upload } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { bankAccountFormSchema, documentCreateSchema } from '@fibrex/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { uploadFile } from '../data/upload';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, PageHeader, Pill, Skeleton } from '../ui/components';
import { EntityForm, type FormField, type FormSchema } from '../ui/EntityForm';
import { HistoryTab } from '../ui/HistoryTab';
import { useToast } from '../ui/toast';
import { PersonPerformanceTab } from '../performance/PersonPerformanceTab';
import { OcrConfirmPanel, type OcrJob } from './OcrScan';

interface Employee {
  id: string;
  partyId: string;
  employeeCode: string;
  displayName: string;
  statusCode: string;
  sponsorship: string;
  recruitingAgentPartyId: string | null;
  joiningDate: string | null;
  version: number;
}
interface DocumentRow {
  id: string;
  documentTypeId: string | null;
  customName: string | null;
  numberMasked: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: string;
  version: number;
}
interface DocumentType {
  id: string;
  code: string;
  name: Record<string, string>;
}
interface Placement {
  id: string;
  profession: string;
  validFrom: string;
  validTo: string | null;
}
interface Period {
  id: string;
  startDate: string;
  endDate: string | null;
  rehireEligible: boolean;
}
export interface BankAccount {
  id: string;
  kind: string;
  bankName: string | null;
  numberMasked: string;
  accountName: string;
  walletProvider: string | null;
  status: string;
  proofFileId: string | null;
  requestedBy: string;
  proofCheckedAt: string | null;
  reviewNote: string | null;
  version: number;
}
type Tab = 'profile' | 'documents' | 'placement' | 'performance' | 'history';
type Tone = 'success' | 'neutral' | 'danger' | 'warning';

const DOC_TONE: Record<string, Tone> = {
  valid: 'success',
  expiring: 'warning',
  expired: 'danger',
  replaced: 'neutral',
};
const BANK_TONE: Record<string, Tone> = {
  verified: 'success',
  pending: 'warning',
  rejected: 'danger',
};
const STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  inactive: 'neutral',
  blocked: 'danger',
  terminated: 'warning',
};
const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** What a bank account row may do for this user: the approval rule in one place (tested). */
export function bankActions(
  account: Pick<BankAccount, 'status' | 'requestedBy' | 'proofFileId' | 'proofCheckedAt'>,
  userId: string | undefined,
  can: (permission: string) => boolean,
) {
  const pending = account.status === 'pending';
  const own = userId !== undefined && account.requestedBy === userId;
  const needsCheck = account.proofFileId !== null && account.proofCheckedAt === null;
  return {
    verify: pending && needsCheck && can('party.bank_account.verify'),
    approve: pending && !own && !needsCheck && can('party.bank_account.approve'),
    reject: pending && !own && can('party.bank_account.approve'),
    waitingForSecondPerson: pending && own,
  };
}

/** Wraps the shared document schema so the owner (this person) is not a form box. */
function documentFormSchema(partyId: string): FormSchema {
  return {
    safeParse: (value) =>
      documentCreateSchema.safeParse({
        ownerType: 'party',
        ownerId: partyId,
        ...(value as Record<string, unknown>),
      }),
  };
}

export function EmployeeProfilePage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const { can } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('profile');

  useEffect(() => {
    api<Employee>(`/employees/${id}`)
      .then(setEmployee)
      .catch((e: unknown) => {
        setError(e);
      });
  }, [id]);

  // Performance figures need their own permission (row 4.6a).
  const tabs: Tab[] = [
    'profile',
    'documents',
    'placement',
    ...(can('performance.report.view') ? (['performance'] as const) : []),
    'history',
  ];
  return (
    <>
      <PageHeader
        title={employee === null ? t('employees.title') : employee.displayName}
        description={
          employee === null ? undefined : (
            <span className="profile-sub">
              <span className="mono">{employee.employeeCode}</span>
              <Pill tone={STATUS_TONE[employee.statusCode] ?? 'neutral'}>
                {employee.statusCode}
              </Pill>
            </span>
          )
        }
        actions={
          <Link to="/employees" className="btn btn-link">
            <ArrowLeft size={16} aria-hidden /> {t('employees.back')}
          </Link>
        }
      />
      <ErrorAlert error={error} />
      {employee === null && error === null ? <Skeleton lines={4} /> : null}
      {employee !== null ? (
        <>
          <div role="tablist" className="tabs">
            {tabs.map((k) => (
              <button
                key={k}
                role="tab"
                type="button"
                aria-selected={tab === k}
                className="tab"
                onClick={() => {
                  setTab(k);
                }}
              >
                {t(`employees.tab.${k}` as const)}
              </button>
            ))}
          </div>
          {tab === 'profile' ? <ProfileTab employee={employee} /> : null}
          {tab === 'documents' ? <DocumentsTab partyId={employee.partyId} /> : null}
          {tab === 'placement' ? <PlacementTab employeeId={employee.id} /> : null}
          {tab === 'performance' ? <PersonPerformanceTab partyId={employee.partyId} /> : null}
          {tab === 'history' ? (
            <HistoryTab entityType="people.employee" entityId={employee.id} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

interface PartyInfo {
  nationalityCode: string | null;
  displayName: string;
}

/** One label and value in the details grid; an empty value shows a dash. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{empty ? '-' : children}</dd>
    </div>
  );
}

/** Profile tab: person details in a two-column card grid, then bank accounts. */
function ProfileTab({ employee }: { employee: Employee }) {
  const { t } = useI18n();
  const [party, setParty] = useState<PartyInfo | null>(null);
  const [phones, setPhones] = useState<string[]>([]);
  const [ids, setIds] = useState<{ type: string; valueMasked: string }[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [profession, setProfession] = useState<string | null>(null);

  // Each lookup is independent and optional: a missing permission leaves a dash, not an error.
  useEffect(() => {
    api<PartyInfo>(`/parties/${employee.partyId}`)
      .then(setParty)
      .catch(() => {
        setParty(null);
      });
    api<{ items: { kind: string; value: string; isPrimary: boolean }[] }>('/party-contacts', {
      query: { partyId: employee.partyId },
    })
      .then((r) => {
        setPhones(
          r.items
            .filter((c) => c.kind === 'phone')
            .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
            .map((c) => c.value),
        );
      })
      .catch(() => {
        setPhones([]);
      });
    api<{ items: { type: string; valueMasked: string }[] }>('/party-identifiers', {
      query: { partyId: employee.partyId },
    })
      .then((r) => {
        setIds(r.items);
      })
      .catch(() => {
        setIds([]);
      });
    api<{ items: Placement[] }>(`/employees/${employee.id}/placements`)
      .then((r) => {
        const sorted = [...r.items].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
        setProfession(sorted[0]?.profession ?? null);
      })
      .catch(() => {
        setProfession(null);
      });
    if (employee.recruitingAgentPartyId) {
      api<PartyInfo>(`/parties/${employee.recruitingAgentPartyId}`)
        .then((r) => {
          setAgent(r.displayName);
        })
        .catch(() => {
          setAgent(null);
        });
    }
  }, [employee.id, employee.partyId, employee.recruitingAgentPartyId]);

  const idOf = (type: string) => ids.find((i) => i.type === type)?.valueMasked ?? null;
  const mono = (v: string | null) => (v === null ? null : <span className="mono">{v}</span>);
  return (
    <>
      <section className="card">
        <dl className="details">
          <Detail label={t('employees.name')}>{employee.displayName}</Detail>
          <Detail label={t('employees.status')}>
            <Pill tone={STATUS_TONE[employee.statusCode] ?? 'neutral'}>{employee.statusCode}</Pill>
          </Detail>
          <Detail label={t('employees.phones')}>
            {phones.length === 0 ? null : (
              <span className="mono" dir="ltr">
                {phones.join(', ')}
              </span>
            )}
          </Detail>
          <Detail label={t('people.nationality')}>{party?.nationalityCode}</Detail>
          <Detail label={t('employees.qid')}>{mono(idOf('qid'))}</Detail>
          <Detail label={t('employees.passport')}>{mono(idOf('passport'))}</Detail>
          <Detail label={t('employees.profession')}>{profession}</Detail>
          <Detail label={t('employees.agent')}>{agent}</Detail>
          <Detail label={t('employees.sponsorship')}>{employee.sponsorship}</Detail>
          <Detail label={t('employees.joiningDate')}>{employee.joiningDate}</Detail>
        </dl>
      </section>
      <PlatformIdsSection partyId={employee.partyId} />
      <BankSection partyId={employee.partyId} />
    </>
  );
}

/**
 * Platform IDs (phase 4 row 4.5a): the person's Falcon IDs with the platform, the dates each
 * was held and whether it is still theirs. Falcon IDs are not sensitive (the vault stores them
 * in clear, `valuePlain`), so they are shown in full. Read through the party identifier API;
 * a missing permission simply hides the section.
 */
interface PlatformId {
  id: string;
  clientPlatformId: string | null;
  valuePlain: string | null;
  valueMasked: string;
  validFrom: string;
  validTo: string | null;
  deletedAt: string | null;
}
function PlatformIdsSection({ partyId }: { partyId: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<PlatformId[] | null>(null);
  const [platforms, setPlatforms] = useState<Record<string, string>>({});

  useEffect(() => {
    api<{ items: PlatformId[] }>('/party-identifiers', { query: { partyId, type: 'falcon_id' } })
      .then((r) => {
        setItems(
          r.items
            .filter((i) => i.deletedAt === null)
            .sort((a, b) => b.validFrom.localeCompare(a.validFrom)),
        );
      })
      .catch(() => {
        setItems(null);
      });
    api<{ items: { id: string; name: string }[] }>('/client-platforms')
      .then((r) => {
        setPlatforms(Object.fromEntries(r.items.map((p) => [p.id, p.name])));
      })
      .catch(() => {
        setPlatforms({});
      });
  }, [partyId]);

  if (items === null) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="card" aria-labelledby="platform-ids-title">
      <h2 id="platform-ids-title">{t('employees.platformIds')}</h2>
      {items.length === 0 ? (
        <p className="muted">{t('employees.platformIds.none')}</p>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>{t('employees.platformIds.platform')}</th>
                <th>{t('employees.platformIds.id')}</th>
                <th>{t('employees.platformIds.from')}</th>
                <th>{t('employees.platformIds.to')}</th>
                <th>{t('employees.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const active = i.validFrom <= today && (i.validTo === null || i.validTo >= today);
                return (
                  <tr key={i.id}>
                    <td data-label={t('employees.platformIds.platform')}>
                      {(i.clientPlatformId !== null ? platforms[i.clientPlatformId] : undefined) ??
                        '—'}
                    </td>
                    <td data-label={t('employees.platformIds.id')} className="mono">
                      {i.valuePlain ?? i.valueMasked}
                    </td>
                    <td data-label={t('employees.platformIds.from')}>{i.validFrom}</td>
                    <td data-label={t('employees.platformIds.to')}>{i.validTo ?? '—'}</td>
                    <td data-label={t('employees.status')}>
                      <Pill tone={active ? 'success' : 'neutral'}>
                        {t(active ? 'employees.platformIds.active' : 'employees.platformIds.ended')}
                      </Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BankSection({ partyId }: { partyId: string }) {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<BankAccount[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const userId = auth.grant?.user.id;

  const load = useCallback(() => {
    api<{ items: BankAccount[] }>('/party-bank-accounts', { query: { partyId } })
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [partyId]);
  useEffect(load, [load]);

  /** One review step; the server re-checks every rule. */
  const step = async (a: BankAccount, action: 'verify' | 'approve' | 'reject', body?: unknown) => {
    try {
      await api(`/party-bank-accounts/${a.id}/${action}`, {
        method: 'POST',
        headers: ifMatch(a.version),
        ...(body === undefined ? {} : { body }),
      });
      toast.show(t('employees.bank.done'), 'success');
      setRejecting(null);
      setNote('');
      load();
    } catch (e) {
      setError(e);
    }
  };

  const fields: FormField[] = [
    {
      name: 'kind',
      label: t('employees.bank.kind'),
      type: 'select',
      options: [
        { value: 'bank', label: t('employees.bank.kind.bank') },
        { value: 'wallet', label: t('employees.bank.kind.wallet') },
      ],
    },
    { name: 'bankName', label: t('employees.bank.bankName') },
    { name: 'number', label: t('employees.bank.number'), hint: t('employees.bank.numberHint') },
    { name: 'accountName', label: t('employees.bank.accountName') },
    { name: 'walletProvider', label: t('employees.bank.walletProvider') },
  ];

  return (
    <section className="card">
      <h2>
        <Landmark size={18} aria-hidden /> {t('employees.bank.title')}
      </h2>
      <p className="muted">{t('employees.bank.rule')}</p>
      <ErrorAlert error={error} />
      {items === null && error === null ? <Skeleton lines={2} /> : null}
      {items?.length === 0 ? <EmptyState title={t('employees.bank.empty')} /> : null}
      <ul className="plain-list">
        {items?.map((a) => {
          const can = bankActions(a, userId, auth.can);
          return (
            <li key={a.id}>
              <strong>{a.accountName}</strong> {a.bankName ?? a.walletProvider ?? ''}{' '}
              <span className="mono">{a.numberMasked}</span>{' '}
              <Pill tone={BANK_TONE[a.status] ?? 'neutral'}>
                {t(`employees.bank.status.${a.status}` as never)}
              </Pill>
              {a.reviewNote !== null ? <span className="muted"> {a.reviewNote}</span> : null}
              {can.waitingForSecondPerson ? (
                <p className="muted">{t('employees.bank.secondPerson')}</p>
              ) : null}
              {can.verify ? (
                <Button
                  variant="link"
                  onClick={() => {
                    void step(a, 'verify');
                  }}
                >
                  {t('employees.bank.verify')}
                </Button>
              ) : null}
              {can.approve ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    void step(a, 'approve');
                  }}
                >
                  {t('employees.bank.approve')}
                </Button>
              ) : null}
              {can.reject ? (
                <Button
                  variant="link"
                  onClick={() => {
                    setRejecting(a.id);
                  }}
                >
                  {t('employees.bank.reject')}
                </Button>
              ) : null}
              {rejecting === a.id ? (
                <span>
                  <input
                    aria-label={t('employees.bank.rejectNote')}
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                    }}
                  />
                  <Button
                    variant="danger"
                    disabled={note.trim() === ''}
                    onClick={() => {
                      void step(a, 'reject', { note: note.trim() });
                    }}
                  >
                    {t('employees.bank.confirmReject')}
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {auth.can('party.bank_account.create') && !adding ? (
        <Button
          icon={Landmark}
          onClick={() => {
            setAdding(true);
          }}
        >
          {t('employees.bank.add')}
        </Button>
      ) : null}
      {adding ? (
        <EntityForm
          fields={fields}
          initial={{ kind: 'bank' }}
          schema={bankAccountFormSchema}
          onCancel={() => {
            setAdding(false);
          }}
          onSubmit={async (values) => {
            await api('/party-bank-accounts', { method: 'POST', body: { partyId, ...values } });
            setAdding(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

function DocumentsTab({ partyId }: { partyId: string }) {
  const { t, language: lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<'none' | 'typed' | 'other'>('none');
  const [ocrJob, setOcrJob] = useState<OcrJob | null>(null);

  const load = useCallback(() => {
    api<{ items: DocumentRow[] }>('/documents', { query: { ownerType: 'party', ownerId: partyId } })
      .then((r) => {
        setDocs(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [partyId]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: DocumentType[] }>('/document-types', { query: { appliesTo: 'party' } })
      .then((r) => {
        setTypes(r.items);
      })
      .catch(() => {
        setTypes([]);
      });
  }, []);

  const typeName = (d: DocumentRow) => {
    if (d.customName !== null) return d.customName;
    const type = types.find((x) => x.id === d.documentTypeId);
    return type === undefined ? '-' : (type.name[lang] ?? type.name.en ?? type.code);
  };

  /** Uploads a scan and attaches it; a one-page type asks to replace its page (409). */
  const addScan = async (d: DocumentRow, file: File) => {
    try {
      const fileObjectId = await uploadFile(file);
      try {
        await api(`/documents/${d.id}/files`, { method: 'POST', body: { fileObjectId } });
      } catch (e) {
        const attachmentId =
          e instanceof ApiError && e.code === 'single_page_document'
            ? (e.problem.attachmentId as string | undefined)
            : undefined;
        if (attachmentId === undefined) throw e;
        await api(`/documents/${d.id}/files`, {
          method: 'POST',
          body: { fileObjectId, replacesAttachmentId: attachmentId },
        });
      }
      toast.show(t('employees.docs.scanAdded'), 'success');
    } catch (e) {
      setError(e);
    }
  };

  /** Row 3.6: upload, read with OCR, then show the confirm panel (nothing saved yet). */
  const scanToFill = async (file: File) => {
    try {
      const fileObjectId = await uploadFile(file);
      const job = await api<OcrJob>('/ocr/jobs', {
        method: 'POST',
        body: { fileObjectId, ownerId: partyId },
      });
      setForm('none');
      setOcrJob(job);
    } catch (e) {
      setError(e);
    }
  };
  const typeOptions = types.map((x) => ({
    value: x.id,
    label: x.name[lang] ?? x.name.en ?? x.code,
  }));

  const typed: FormField[] = [
    {
      name: 'documentTypeId',
      label: t('employees.docs.type'),
      type: 'select',
      options: [{ value: '', label: t('common.choose') }, ...typeOptions],
    },
    { name: 'number', label: t('employees.docs.number') },
    { name: 'issueDate', label: t('employees.docs.issueDate'), hint: 'YYYY-MM-DD' },
    { name: 'expiryDate', label: t('employees.docs.expiryDate'), hint: 'YYYY-MM-DD' },
  ];
  const other: FormField[] = [
    { name: 'customName', label: t('employees.docs.otherName') },
    ...typed.slice(1),
  ];

  return (
    <section className="card">
      <ErrorAlert error={error} />
      {auth.can('people.document.create') ? (
        <p className="doc-actions">
          <Button
            icon={FilePlus}
            onClick={() => {
              setForm('typed');
            }}
          >
            {t('employees.docs.add')}
          </Button>{' '}
          <Button
            variant="default"
            onClick={() => {
              setForm('other');
            }}
          >
            {t('employees.docs.addOther')}
          </Button>{' '}
          {auth.can('people.ocr_job.create') ? (
            <label className="btn">
              <ScanText size={16} aria-hidden /> {t('employees.docs.scanToFill')}
              <input
                type="file"
                hidden
                accept="image/*,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file !== undefined) void scanToFill(file);
                }}
              />
            </label>
          ) : null}
        </p>
      ) : null}
      {ocrJob !== null ? (
        <OcrConfirmPanel
          key={ocrJob.id}
          job={ocrJob}
          partyId={partyId}
          typeOptions={typeOptions}
          onCancel={() => {
            setOcrJob(null);
          }}
          onDone={() => {
            setOcrJob(null);
            toast.show(t('ocr.saved'), 'success');
            load();
          }}
        />
      ) : null}
      {form !== 'none' ? (
        <EntityForm
          fields={form === 'typed' ? typed : other}
          schema={documentFormSchema(partyId)}
          onCancel={() => {
            setForm('none');
          }}
          onSubmit={async (values) => {
            await api('/documents', {
              method: 'POST',
              body: { ownerType: 'party', ownerId: partyId, ...values },
            });
            setForm('none');
            load();
          }}
        />
      ) : null}
      {docs === null && error === null ? <Skeleton lines={3} /> : null}
      {docs?.length === 0 ? <EmptyState title={t('employees.docs.empty')} /> : null}
      <ul className="plain-list">
        {docs?.map((d) => (
          <li key={d.id}>
            <strong>{typeName(d)}</strong> <span className="mono">{d.numberMasked ?? ''}</span>{' '}
            {d.expiryDate ?? ''} <Pill tone={DOC_TONE[d.status] ?? 'neutral'}>{d.status}</Pill>{' '}
            {auth.can('people.document.update') && d.status !== 'replaced' ? (
              <label className="btn btn-link">
                <Upload size={16} aria-hidden /> {t('employees.docs.addScan')}
                <input
                  type="file"
                  hidden
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file !== undefined) void addScan(d, file);
                  }}
                />
              </label>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlacementTab({ employeeId }: { employeeId: string }) {
  const { t } = useI18n();
  const [placements, setPlacements] = useState<Placement[] | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ items: Placement[] }>(`/employees/${employeeId}/placements`)
      .then((r) => {
        setPlacements(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
    api<{ items: Period[] }>(`/employees/${employeeId}/employment-periods`)
      .then((r) => {
        setPeriods(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [employeeId]);

  return (
    <section className="card">
      <ErrorAlert error={error} />
      <h2>{t('employees.placement.title')}</h2>
      {placements === null && error === null ? <Skeleton lines={2} /> : null}
      {placements?.length === 0 ? <EmptyState title={t('employees.placement.empty')} /> : null}
      <ul className="plain-list">
        {placements?.map((p) => (
          <li key={p.id}>
            <strong>{p.profession}</strong> {p.validFrom} →{' '}
            {p.validTo ?? t('employees.placement.current')}
          </li>
        ))}
      </ul>
      <h2>{t('employees.periods.title')}</h2>
      <ul className="plain-list">
        {periods.map((p) => (
          <li key={p.id}>
            {p.startDate} → {p.endDate ?? t('employees.placement.current')}
          </li>
        ))}
      </ul>
    </section>
  );
}
