/**
 * DataTable: the one list component. Server-side paging and search (the parent owns `page`
 * and the search text and loads the rows), client-side sort of the loaded page, a column
 * chooser, and CSV export of the rows on screen.
 * Responsive: on a phone (below 768 px) each row is a card (the first column is the title,
 * the next three visible columns are its fields, the row actions sit in a "⋯" menu), the
 * filters move into a bottom sheet behind a "Filters" button, and the pager shrinks to
 * icon buttons with "page / pages". Above that it is a classic table in a card.
 * Why CSV only: Excel opens CSV directly; PDF export is a print style, added with the
 * reports work (listed in PROGRESS.md).
 * Export safety: a cell that starts with = + - or @ is prefixed with an apostrophe so a
 * spreadsheet never runs it as a formula (CSV injection).
 * Depends on: ui/components, ui/Menu, ui/Modal, theme/useBreakpoint, i18n.
 * Used by: every list screen.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Ellipsis,
  SlidersHorizontal,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useBreakpoint } from '../theme/useBreakpoint';
import { Button, Checkbox, EmptyState, ErrorAlert, SearchInput, Skeleton } from './components';
import { Menu } from './Menu';
import { Modal } from './Modal';

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
  /** Extra controls (filters) shown next to the search box (in a sheet on a phone). */
  toolbar?: ReactNode;
  exportName?: string;
  /** Per-row buttons shown in a last column (in a menu on a phone). */
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

/** How many fields a card shows under its title. */
const CARD_FIELDS = 3;

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
  const mobile = useBreakpoint() === 'mobile';
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  const cellOf = (c: Column<T>, row: T) => (c.render ? c.render(row) : String(c.value(row) ?? ''));
  const toggleSort = (key: string) => {
    setSort(sort?.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 });
  };

  const columnChooser = (
    <Menu
      label={t('table.columns')}
      icon={Columns3}
      iconOnly={mobile}
      panelClassName="column-chooser-panel"
    >
      {columns.map((c) => (
        <Checkbox
          key={c.key}
          data-keep-open
          label={c.header}
          checked={!hidden.has(c.key)}
          onChange={(e) => {
            const next = new Set(hidden);
            if (e.target.checked) next.delete(c.key);
            else next.add(c.key);
            setHidden(next);
          }}
        />
      ))}
    </Menu>
  );

  const body =
    loading === true ? (
      <Skeleton lines={6} />
    ) : rows.length === 0 ? (
      <EmptyState />
    ) : mobile ? (
      <ul className="row-cards" aria-label={t('table.rows', { total })}>
        {sorted.map((row) => {
          const [title, ...fields] = shown;
          return (
            <li key={rowKey(row)} className="row-card">
              <div className="row-card-head">
                <div className="row-card-title">{title ? cellOf(title, row) : null}</div>
                {actions ? (
                  <Menu
                    label={t('common.actions')}
                    icon={Ellipsis}
                    iconOnly
                    variant="ghost"
                    size="sm"
                  >
                    {actions(row)}
                  </Menu>
                ) : null}
              </div>
              {fields.length > 0 ? (
                <dl>
                  {fields.slice(0, CARD_FIELDS).map((c) => (
                    <div key={c.key} style={{ display: 'contents' }}>
                      <dt>{c.header}</dt>
                      <dd>{cellOf(c, row)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    ) : (
      <div className="table-card">
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
                          toggleSort(c.key);
                        }}
                      >
                        {c.header}
                        {sort?.key === c.key ? (
                          sort.dir === 1 ? (
                            <ArrowUp aria-hidden />
                          ) : (
                            <ArrowDown aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown aria-hidden />
                        )}
                      </button>
                    )}
                  </th>
                ))}
                {actions ? <th className="td-actions">{t('common.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={rowKey(row)}>
                  {shown.map((c) => (
                    <td key={c.key}>{cellOf(c, row)}</td>
                  ))}
                  {actions ? (
                    <td className="td-actions">
                      <div className="row-actions">{actions(row)}</div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

  return (
    <div className="datatable">
      <div className="table-toolbar">
        {onSearch ? (
          <SearchInput
            label={t('table.search')}
            value={search ?? ''}
            onChange={(e) => {
              onSearch(e.target.value);
            }}
          />
        ) : null}
        {toolbar !== undefined && toolbar !== null && !mobile ? (
          <div className="table-filters">{toolbar}</div>
        ) : null}
        <div className="table-tools">
          {toolbar !== undefined && toolbar !== null && mobile ? (
            <Button
              icon={SlidersHorizontal}
              onClick={() => {
                setFiltersOpen(true);
              }}
            >
              {t('table.filters')}
            </Button>
          ) : null}
          {columnChooser}
          <Button
            icon={Download}
            iconOnly={mobile}
            aria-label={t('table.export')}
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            {t('table.export')}
          </Button>
        </div>
      </div>
      <ErrorAlert error={error} />
      {body}
      {pages > 1 || !mobile ? (
        <div className="table-pager">
          <span>
            {mobile
              ? t('table.pageShort', { page, pages })
              : t('table.pageOf', { page, pages, total })}
          </span>
          <div className="table-pager-buttons">
            <Button
              icon={ChevronLeft}
              iconOnly={mobile}
              aria-label={t('table.prev')}
              disabled={page <= 1}
              onClick={() => {
                onPageChange(page - 1);
              }}
            >
              {t('table.prev')}
            </Button>
            <Button
              icon={ChevronRight}
              iconOnly={mobile}
              aria-label={t('table.next')}
              disabled={page >= pages}
              onClick={() => {
                onPageChange(page + 1);
              }}
            >
              {t('table.next')}
            </Button>
          </div>
        </div>
      ) : null}
      {mobile && toolbar !== undefined && toolbar !== null ? (
        <Modal
          variant="sheet"
          open={filtersOpen}
          onClose={() => {
            setFiltersOpen(false);
          }}
          aria-label={t('table.filters')}
        >
          <div className="dialog-head">
            <h2>{t('table.filters')}</h2>
          </div>
          <div className="filter-sheet">{toolbar}</div>
          <div className="dialog-actions">
            <Button
              variant="primary"
              onClick={() => {
                setFiltersOpen(false);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
