/**
 * Unmatched riders (phase 4 row 4.5b): the Falcon IDs of the platform report that belong to
 * nobody yet, with what the sheet says about them, and the three ways to settle each one.
 *
 * Rules, and why:
 *   - Link to an existing employee: the picker first shows the best name matches for the
 *     sheet's name, and searches by name, phone or code as the user types. The ID is held from
 *     the first date it was seen unless the user changes the date; the API refuses an ID that
 *     another person holds in an overlapping period and says who holds it.
 *   - Create employee: made from the sheet's name, phone, driver or rider and zone. A shared
 *     phone number is a warning the user must confirm ("Create anyway"), never silent.
 *   - Ignore: needs a reason, so a later reader knows why the ID has no person.
 *   - Linking or creating attaches the stored figures of that ID in the same step; the toast
 *     says how many days moved and how many stayed unmatched.
 *   - Buttons show only to people who may resolve (`performance.unmatched.resolve`); creating
 *     an employee also needs `people.employee.create`.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (sheet helpers), toast.
 * Used by: App.tsx (route /performance/unmatched).
 */
import { useCallback, useEffect, useState } from 'react';
import { UserRoundSearch, Link2, UserPlus, EyeOff } from 'lucide-react';
import { sheetProfessionCode } from '@fibrex/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  SearchInput,
  Select,
  Skeleton,
  Textarea,
  type PillTone,
} from '../ui/components';
import { useToast } from '../ui/toast';

type Status = 'open' | 'linked' | 'created' | 'ignored';
interface Item {
  id: string;
  clientPlatformId: string;
  platformName: string;
  externalId: string;
  firstSeen: string;
  lastSeen: string;
  status: Status;
  ordersSeen: number;
  daysSeen: number;
  sheetName: string | null;
  sheetPhone: string | null;
  sheetProfession: string | null;
  sheetPlate: string | null;
  sheetZone: string | null;
  resolvedPartyName: string | null;
  ignoreReason: string | null;
}
interface QueuePage {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
}
interface Candidate {
  employeeId: string;
  displayName: string;
  employeeCode: string;
  phone: string | null;
}
interface Resolved {
  attachedRows: number;
  leftUnmatched: number;
  employeeCode: string | null;
}

const tone = (s: Status): PillTone =>
  s === 'open' ? 'warning' : s === 'ignored' ? 'neutral' : 'success';

type Dialog =
  | { kind: 'link'; item: Item }
  | { kind: 'create'; item: Item }
  | { kind: 'ignore'; item: Item }
  | null;

export function UnmatchedPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canResolve = auth.can('performance.unmatched.resolve');
  const canCreate = canResolve && auth.can('people.employee.create');
  const [data, setData] = useState<QueuePage | null>(null);
  const [platforms, setPlatforms] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('open');
  const [platform, setPlatform] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);

  // The search box waits for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setApplied(search.trim());
      setPage(1);
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search]);

  const load = useCallback(() => {
    api<QueuePage>('/unmatched-identifiers', {
      query: {
        page,
        pageSize: 25,
        ...(status === '' ? {} : { status }),
        ...(platform === '' ? {} : { platform }),
        ...(applied === '' ? {} : { search: applied }),
      },
    })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [page, status, platform, applied]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/client-platforms')
      .then((r) => {
        setPlatforms(r.items);
      })
      .catch(() => {
        setPlatforms([]);
      });
  }, []);

  const done = (result: Resolved | null, message: string) => {
    setDialog(null);
    toast.show(message, 'success');
    if (result !== null && result.leftUnmatched > 0) {
      toast.show(t('unmatched.leftUnmatched', { rows: String(result.leftUnmatched) }), 'info');
    }
    load();
  };

  const pages = data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div>
      <PageHeader
        title={t('unmatched.title')}
        icon={UserRoundSearch}
        description={t('unmatched.intro')}
      />
      <ErrorAlert error={error} />
      <div className="toolbar">
        <SearchInput
          label={t('unmatched.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select
          label={t('unmatched.status')}
          value={status}
          placeholder={t('unmatched.allStatuses')}
          options={(['open', 'linked', 'created', 'ignored'] as const).map((s) => ({
            value: s,
            label: t(`unmatched.status.${s}` as const),
          }))}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        />
        {platforms.length > 1 ? (
          <Select
            label={t('unmatched.platform')}
            value={platform}
            placeholder={t('unmatched.allPlatforms')}
            options={platforms.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(e) => {
              setPlatform(e.target.value);
              setPage(1);
            }}
          />
        ) : null}
      </div>

      {data === null ? (
        <Skeleton />
      ) : data.items.length === 0 ? (
        <EmptyState title={t('unmatched.none')} />
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>{t('unmatched.falconId')}</th>
                  <th>{t('unmatched.name')}</th>
                  <th>{t('unmatched.seen')}</th>
                  <th>{t('unmatched.orders')}</th>
                  <th>{t('unmatched.status')}</th>
                  <th>{t('unmatched.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('unmatched.falconId')}>
                      <strong className="nowrap">{r.externalId}</strong>
                      {platforms.length > 1 ? <div className="muted">{r.platformName}</div> : null}
                    </td>
                    <td data-label={t('unmatched.name')}>
                      {r.sheetName ?? '—'}
                      <div>{r.sheetPhone ?? '—'}</div>
                      <div className="muted">
                        {[r.sheetProfession, r.sheetZone, r.sheetPlate]
                          .filter((x): x is string => x !== null && x !== '' && x !== 'NA')
                          .join(' · ')}
                      </div>
                    </td>
                    <td data-label={t('unmatched.seen')}>
                      <span className="nowrap">{r.firstSeen}</span>
                      <div className="muted nowrap">→ {r.lastSeen}</div>
                    </td>
                    <td data-label={t('unmatched.orders')}>
                      {r.ordersSeen}
                      <div className="muted">
                        {t('unmatched.days', { days: String(r.daysSeen) })}
                      </div>
                    </td>
                    <td data-label={t('unmatched.status')}>
                      <Pill tone={tone(r.status)}>
                        {t(`unmatched.status.${r.status}` as const)}
                      </Pill>
                      {r.resolvedPartyName !== null ? (
                        <div className="muted">{r.resolvedPartyName}</div>
                      ) : null}
                      {r.ignoreReason !== null ? (
                        <div className="muted">{r.ignoreReason}</div>
                      ) : null}
                    </td>
                    <td data-label={t('unmatched.actions')}>
                      {r.status === 'open' && canResolve ? (
                        <div className="row-actions">
                          <Button
                            size="sm"
                            icon={Link2}
                            onClick={() => {
                              setDialog({ kind: 'link', item: r });
                            }}
                          >
                            {t('unmatched.link')}
                          </Button>
                          {canCreate ? (
                            <Button
                              size="sm"
                              icon={UserPlus}
                              onClick={() => {
                                setDialog({ kind: 'create', item: r });
                              }}
                            >
                              {t('unmatched.create')}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            icon={EyeOff}
                            onClick={() => {
                              setDialog({ kind: 'ignore', item: r });
                            }}
                          >
                            {t('unmatched.ignore')}
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {pages > 1 ? (
        <div className="toolbar">
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage(page - 1);
            }}
          >
            {t('common.previous')}
          </Button>
          <span className="muted">
            {t('runs.page', { page: String(page), pages: String(pages) })}
          </span>
          <Button
            size="sm"
            disabled={page >= pages}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}

      {dialog?.kind === 'link' ? (
        <LinkDialog
          item={dialog.item}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(r) => {
            done(r, t('unmatched.linked', { rows: String(r.attachedRows) }));
          }}
        />
      ) : null}
      {dialog?.kind === 'create' ? (
        <CreateDialog
          item={dialog.item}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(r) => {
            done(r, t('unmatched.created', { code: r.employeeCode ?? '' }));
          }}
        />
      ) : null}
      {dialog?.kind === 'ignore' ? (
        <IgnoreDialog
          item={dialog.item}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            done(null, t('unmatched.ignored'));
          }}
        />
      ) : null}
    </div>
  );
}

interface DialogProps {
  item: Item;
  onClose: () => void;
}

function LinkDialog({
  item,
  onClose,
  onDone,
}: DialogProps & { onDone: (result: Resolved) => void }) {
  const { t } = useI18n();
  const [suggested, setSuggested] = useState<Candidate[]>([]);
  const [results, setResults] = useState<Candidate[]>([]);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [validFrom, setValidFrom] = useState(item.firstSeen);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Best name matches for the sheet's name, and the search results, are both one request.
  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        api<{ suggested: Candidate[]; results: Candidate[] }>(
          `/unmatched-identifiers/${item.id}/candidates`,
          { query: q.trim() === '' ? {} : { q: q.trim() } },
        )
          .then((r) => {
            setSuggested(r.suggested);
            setResults(r.results);
          })
          .catch((e: unknown) => {
            setError(e);
          });
      },
      q === '' ? 0 : 300,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [item.id, q]);

  const submit = () => {
    if (chosen === null) return;
    setBusy(true);
    setError(null);
    api<Resolved>(`/unmatched-identifiers/${item.id}/link`, {
      method: 'POST',
      body: { employeeId: chosen.employeeId, validFrom },
    })
      .then(onDone)
      .catch((e: unknown) => {
        setError(e);
        setBusy(false);
      });
  };

  const pick = (c: Candidate) => (
    <li key={c.employeeId}>
      <button
        type="button"
        className={chosen?.employeeId === c.employeeId ? 'pick pick-on' : 'pick'}
        aria-pressed={chosen?.employeeId === c.employeeId}
        onClick={() => {
          setChosen(c);
        }}
      >
        <strong>{c.displayName}</strong>
        <span className="muted">
          {c.employeeCode}
          {c.phone === null ? '' : ` · ${c.phone}`}
        </span>
      </button>
    </li>
  );

  return (
    <Modal open onClose={onClose} aria-labelledby="unmatched-link-title">
      <h2 id="unmatched-link-title">{t('unmatched.linkTitle', { id: item.externalId })}</h2>
      <p className="muted">
        {t('unmatched.sheetSays', { name: item.sheetName ?? '—', phone: item.sheetPhone ?? '—' })}
      </p>
      <ErrorAlert error={error} />
      {suggested.length > 0 ? (
        <>
          <h3>{t('unmatched.suggested')}</h3>
          <ul className="pick-list">{suggested.map(pick)}</ul>
        </>
      ) : null}
      <SearchInput
        label={t('unmatched.searchEmployee')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      {q.trim() !== '' ? (
        results.length === 0 ? (
          <p className="muted">{t('unmatched.noCandidates')}</p>
        ) : (
          <ul className="pick-list">{results.map(pick)}</ul>
        )
      ) : null}
      <Field
        label={t('unmatched.validFrom')}
        hint={t('unmatched.validFromHelp')}
        type="date"
        value={validFrom}
        onChange={(e) => {
          setValidFrom(e.target.value);
        }}
      />
      <div className="dialog-actions">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={busy || chosen === null || validFrom === ''}
          onClick={submit}
        >
          {t('unmatched.confirmLink')}
        </Button>
      </div>
    </Modal>
  );
}

function CreateDialog({
  item,
  onClose,
  onDone,
}: DialogProps & { onDone: (result: Resolved) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(item.sheetName ?? '');
  const [phone, setPhone] = useState(item.sheetPhone ?? '');
  const [profession, setProfession] = useState<string>(
    sheetProfessionCode(item.sheetProfession) ?? '',
  );
  const [joining, setJoining] = useState(item.firstSeen);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState(false);

  const submit = (acknowledgeDuplicates: boolean) => {
    setBusy(true);
    setError(null);
    api<Resolved>(`/unmatched-identifiers/${item.id}/create-employee`, {
      method: 'POST',
      body: {
        displayName: name.trim(),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        ...(profession === '' ? {} : { profession }),
        joiningDate: joining,
        ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      },
    })
      .then(onDone)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'possible_duplicate') setDuplicate(true);
        else setError(e);
        setBusy(false);
      });
  };

  return (
    <Modal open onClose={onClose} aria-labelledby="unmatched-create-title">
      <h2 id="unmatched-create-title">{t('unmatched.createTitle')}</h2>
      <p className="muted">{t('unmatched.createHelp')}</p>
      <ErrorAlert error={error} />
      {duplicate ? <p role="alert">{t('unmatched.sameNameWarning')}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(duplicate);
        }}
      >
        <Field
          label={t('unmatched.displayName')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Field
          label={t('unmatched.phone')}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setDuplicate(false);
          }}
        />
        <Select
          label={t('unmatched.profession')}
          value={profession}
          placeholder={t('common.choose')}
          options={[
            { value: 'rider', label: t('unmatched.rider') },
            { value: 'driver', label: t('unmatched.driver') },
          ]}
          onChange={(e) => {
            setProfession(e.target.value);
          }}
        />
        <Field
          label={t('unmatched.joining')}
          type="date"
          value={joining}
          onChange={(e) => {
            setJoining(e.target.value);
          }}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || name.trim() === '' || profession === '' || joining === ''}
          >
            {duplicate ? t('unmatched.createAnyway') : t('unmatched.confirmCreate')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function IgnoreDialog({ item, onClose, onDone }: DialogProps & { onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal open onClose={onClose} aria-labelledby="unmatched-ignore-title">
      <h2 id="unmatched-ignore-title">{t('unmatched.ignoreTitle', { id: item.externalId })}</h2>
      <p className="muted">{t('unmatched.ignoreHelp')}</p>
      <ErrorAlert error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          api(`/unmatched-identifiers/${item.id}/ignore`, {
            method: 'POST',
            body: { reason: reason.trim() },
          })
            .then(onDone)
            .catch((err: unknown) => {
              setError(err);
              setBusy(false);
            });
        }}
      >
        <Textarea
          label={t('unmatched.reason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || reason.trim().length < 2}>
            {t('unmatched.confirmIgnore')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
