/**
 * DataTable: the one list component. Server-side paging and search (the parent owns `page`
 * and the search text and loads the rows), client-side sort of the loaded page, a column
 * chooser, and CSV export of the rows on screen.
 * Why CSV only: Excel opens CSV directly; PDF export is a print style, added with the
 * reports work (listed in PROGRESS.md).
 * Export safety: a cell that starts with = + - or @ is prefixed with an apostrophe so a
 * spreadsheet never runs it as a formula (CSV injection).
 * Depends on: ui/components, i18n. Used by: every list screen.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, Skeleton } from './components';

export interface Column<T> {
  key: string;
  header: string;
  /** What to show; defaults to the `value`. */
  render?: (row: T) => ReactNode;
  /** Plain value, used for sorting and export. */
  value: (row: T) => string | number | boolean | null | undefined;
  sortable?: boolean;
}

interface Props<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Current search text and its setter; omit both for a table with no search box. */
  search?: string;
  onSearch?: (text: string) => void;
  loading?: boolean;
  error?: unknown;
  /** Extra controls (filters) shown next to the search box. */
  toolbar?: ReactNode;
  exportName?: string;
  /** Per-row buttons shown in a last column. */
  actions?: (row: T) => ReactNode;
}

/** One CSV cell: quoted, quotes doubled, formula starters neutralised. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return [head, ...body].join('\r\n');
}

type Cell = string | number | boolean | null | undefined;
function compare(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  total,
  page,
  pageSize,
  onPageChange,
  search,
  onSearch,
  loading,
  error,
  toolbar,
  exportName = 'export',
  actions,
}: Props<T>) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const shown = columns.filter((c) => !hidden.has(c.key));
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (sort === null || col === undefined) return rows;
    return [...rows].sort((x, y) => sort.dir * compare(col.value(x), col.value(y)));
  }, [rows, columns, sort]);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const exportCsv = () => {
    const blob = new Blob(['﻿', toCsv(shown, sorted)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="datatable">
      <div className="table-toolbar">
        {onSearch ? (
          <input
            type="search"
            aria-label={t('table.search')}
            placeholder={t('table.search')}
            value={search ?? ''}
            onChange={(e) => {
              onSearch(e.target.value);
            }}
          />
        ) : null}
        {toolbar}
        <span className="spacer" />
        <details className="column-chooser">
          <summary>{t('table.columns')}</summary>
          {columns.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={!hidden.has(c.key)}
                onChange={(e) => {
                  const next = new Set(hidden);
                  if (e.target.checked) next.delete(c.key);
                  else next.add(c.key);
                  setHidden(next);
                }}
              />{' '}
              {c.header}
            </label>
          ))}
        </details>
        <Button onClick={exportCsv} disabled={rows.length === 0}>
          {t('table.export')}
        </Button>
      </div>
      <ErrorAlert error={error} />
      {loading === true ? (
        <Skeleton lines={5} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {shown.map((c) => (
                  <th
                    key={c.key}
                    aria-sort={
                      sort?.key === c.key
                        ? sort.dir === 1
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {c.sortable === false ? (
                      c.header
                    ) : (
                      <button
                        type="button"
                        className="th-sort"
                        aria-label={t('table.sortBy', { column: c.header })}
                        onClick={() => {
                          setSort(
                            sort?.key === c.key
                              ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 }
                              : { key: c.key, dir: 1 },
                          );
                        }}
                      >
                        {c.header}
                      </button>
                    )}
                  </th>
                ))}
                {actions ? <th>{t('common.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={rowKey(row)}>
                  {shown.map((c) => (
                    <td key={c.key}>{c.render ? c.render(row) : String(c.value(row) ?? '')}</td>
                  ))}
                  {actions ? <td>{actions(row)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-pager">
        <Button
          disabled={page <= 1}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          {t('table.prev')}
        </Button>
        <span>{t('table.pageOf', { page, pages, total })}</span>
        <Button
          disabled={page >= pages}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          {t('table.next')}
        </Button>
      </div>
    </div>
  );
}
