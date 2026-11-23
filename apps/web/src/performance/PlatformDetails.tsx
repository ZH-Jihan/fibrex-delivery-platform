/**
 * Platform sheet details of one person (phase 4 row 4.8c): day off, duty time, break, zone,
 * plate, COD (pending amount), skill, tags and the last seven days, as friendly values.
 *
 * Used twice, with the same fields: the "Details" panel of the morning call sheet and the
 * "Platform details" section of the employee profile's Performance tab. Both get one
 * `PlatformDetails` object from the server, so the two screens cannot drift apart.
 *
 * Rules, and why:
 *   - The server parses the sheet; this file only formats. A value the sheet marks "Not
 *     updated" arrives empty with a flag and shows as "—" plus a small hint, never as a guess.
 *   - Weekday names come from the browser's own date names in the chosen language
 *     (`Intl`), so no weekday word is hard-coded.
 *   - The COD (pending amount) shows only when the server says amounts are visible
 *     (`amountsVisible`, from performance.amounts.view); without it the server sends none.
 *     The balance amount is shown only here, under the small "Other" heading.
 *
 * Depends on: api client, i18n, ui components. Used by: tracking/CallSheetPage.tsx and
 * ./PersonPerformanceTab.tsx.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { useI18n, type Language } from '../i18n';
import { EmptyState, ErrorAlert, Pill, Skeleton } from '../ui/components';

export interface SheetTime {
  from: string | null;
  to: string | null;
  text: string | null;
  notUpdated: boolean;
}
export interface Amount {
  amount: string;
  currency: string;
}
export interface SheetDetails {
  found: boolean;
  asOfDate: string | null;
  updatedAt: string | null;
  dayOff: { text: string | null; weekdays: number[]; isToday: boolean; notUpdated: boolean };
  dutyTime: SheetTime;
  break: SheetTime;
  zone: string | null;
  plate: string | null;
  vehicleType: string | null;
  skill: string | null;
  tags: string | null;
  contactNumber: string | null;
  company: string | null;
  cod: Amount | null;
  balance: Amount | null;
  notUpdatedFields: string[];
}
export interface PlatformDetails {
  partyId: string;
  date: string;
  sheet: SheetDetails;
  platformIds: { identifierId: string; type: string; value: string; validFrom: string }[];
  recentDays: { date: string; reported: boolean; orders: number | null; hours: number | null }[];
  amountsVisible: boolean;
}

/** Weekday number (0 = Sunday) as a name in the language (a Sunday of 2023 is the base). */
export function weekdayName(index: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + index)),
  );
}

/** The day off as weekday names, else the sheet's own words; empty when there is none. */
export function dayOffLabel(sheet: SheetDetails, language: Language): string {
  const { weekdays, text } = sheet.dayOff;
  return weekdays.length > 0
    ? weekdays.map((d) => weekdayName(d, language)).join(', ')
    : (text ?? '');
}

/** "from - to" of a duty time or break, else the sheet's own text; empty when none. */
export function timeLabel(time: SheetTime): string {
  if (time.from !== null || time.to !== null) return `${time.from ?? '?'} - ${time.to ?? '?'}`;
  return time.text ?? '';
}

/** An amount with its currency code, two decimals ("QAR 1,250.50"). */
export function moneyLabel(amount: Amount): string {
  const n = Number(amount.amount);
  return `${amount.currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A value, or "—" with the small "Not updated" hint when the sheet said so. */
export function SheetValue({ value, notUpdated }: { value: string; notUpdated?: boolean }) {
  const { t } = useI18n();
  if (value !== '') return <>{value}</>;
  return (
    <>
      <span className="muted">—</span>
      {notUpdated === true ? (
        <small className="muted"> {t('sheetDetails.notUpdated')}</small>
      ) : null}
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Imported IDs without a joining date start at the placeholder 1900-01-01: "start unknown". */
const UNKNOWN_START = '1950-01-01';

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** Every sheet detail of the person, plus the last seven days as a small table. */
export function PlatformDetailsView({
  data,
  extra,
}: {
  data: PlatformDetails;
  /** Fields only the call sheet panel adds (name, code, phone, profession). */
  extra?: ReactNode;
}) {
  const { t, language } = useI18n();
  const s = data.sheet;
  const flagged = (key: string) => s.notUpdatedFields.includes(key);
  return (
    <div className="stack">
      {!s.found ? <p className="muted">{t('sheetDetails.noRow')}</p> : null}
      <dl className="details">
        {extra}
        <Detail label={t('sheetDetails.falconIds')}>
          {data.platformIds.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <ul className="plain-list">
              {data.platformIds.map((p) => (
                <li key={p.identifierId}>
                  <span className="mono">{p.value}</span>{' '}
                  <small className="muted">
                    {p.validFrom < UNKNOWN_START
                      ? t('sheetDetails.startUnknown')
                      : t('sheetDetails.validFrom', { date: p.validFrom })}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail label={t('sheetDetails.vehicleType')}>
          <SheetValue value={s.vehicleType ?? ''} />
        </Detail>
        <Detail label={t('sheetDetails.plate')}>
          <SheetValue value={s.plate ?? ''} />
        </Detail>
        <Detail label={t('sheetDetails.zone')}>
          <SheetValue value={s.zone ?? ''} notUpdated={flagged('zone')} />
        </Detail>
        <Detail label={t('sheetDetails.dayOff')}>
          <SheetValue value={dayOffLabel(s, language)} notUpdated={s.dayOff.notUpdated} />
          {s.dayOff.isToday ? <Pill tone="warning">{t('sheetDetails.dayOffToday')}</Pill> : null}
        </Detail>
        <Detail label={t('sheetDetails.dutyTime')}>
          <SheetValue value={timeLabel(s.dutyTime)} notUpdated={s.dutyTime.notUpdated} />
        </Detail>
        <Detail label={t('sheetDetails.break')}>
          <SheetValue value={timeLabel(s.break)} notUpdated={s.break.notUpdated} />
        </Detail>
        {data.amountsVisible ? (
          <Detail label={t('sheetDetails.cod')}>
            <SheetValue value={s.cod === null ? '' : moneyLabel(s.cod)} />
          </Detail>
        ) : null}
        <Detail label={t('sheetDetails.skill')}>
          <SheetValue value={s.skill ?? ''} />
        </Detail>
        <Detail label={t('sheetDetails.tags')}>
          <SheetValue value={s.tags ?? ''} />
        </Detail>
        <Detail label={t('sheetDetails.updatedAt')}>
          <SheetValue value={s.updatedAt === null ? '' : when(s.updatedAt)} />
          {s.asOfDate === null ? null : (
            <small className="muted"> {t('sheetDetails.asOf', { date: s.asOfDate })}</small>
          )}
        </Detail>
      </dl>

      {data.amountsVisible ? (
        <>
          <h4 className="muted-heading">{t('sheetDetails.other')}</h4>
          <dl className="details">
            <Detail label={t('sheetDetails.balance')}>
              <SheetValue value={s.balance === null ? '' : moneyLabel(s.balance)} />
            </Detail>
          </dl>
        </>
      ) : null}

      <h4 className="muted-heading">{t('sheetDetails.lastDays')}</h4>
      {data.recentDays.length === 0 ? (
        <EmptyState title={t('perfReports.empty.title')} />
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>{t('perfReports.col.date')}</th>
                  <th className="num">{t('perfReports.col.orders')}</th>
                  <th className="num">{t('perfReports.col.hoursActive')}</th>
                </tr>
              </thead>
              <tbody>
                {data.recentDays.map((d) => (
                  <tr key={d.date} className={d.reported ? undefined : 'row-muted'}>
                    <td data-label={t('perfReports.col.date')}>{d.date}</td>
                    {d.reported ? (
                      <>
                        <td className="num" data-label={t('perfReports.col.orders')}>
                          {d.orders ?? '—'}
                        </td>
                        <td className="num" data-label={t('perfReports.col.hoursActive')}>
                          {d.hours ?? '—'}
                        </td>
                      </>
                    ) : (
                      <td colSpan={2}>{t('perfPerson.notReported')}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Loads the details from `path` (with `query`) and shows them; loading and error states too. */
export function PlatformDetailsLoader({
  path,
  date,
  extra,
}: {
  path: string;
  date: string;
  extra?: ReactNode;
}) {
  const [data, setData] = useState<PlatformDetails | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api<PlatformDetails>(path, { query: { date } })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [path, date]);
  return (
    <>
      <ErrorAlert error={error} />
      {data === null && error === null ? <Skeleton lines={5} /> : null}
      {data === null ? null : <PlatformDetailsView data={data} extra={extra} />}
    </>
  );
}
