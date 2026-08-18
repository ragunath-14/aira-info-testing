'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Inbox, Search } from 'lucide-react';
import { Button, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Table with client-side search, sort and pagination.
 *
 * Used for lists the API already returns whole (droplets, guests, services) —
 * those are bounded by the size of the estate. Genuinely large result sets (logs,
 * audit events, query history, table data) page on the server instead, because
 * pulling thousands of rows into the browser is what spec section 38 forbids.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Value used for sorting and search. */
  value?: (row: T) => string | number | null;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  width?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  searchPlaceholder = 'Search…',
  searchable = true,
  pageSize: initialPageSize = 25,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  toolbar,
  onRowClick,
  rowClassName,
  dense = false,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  loading?: boolean;
  searchPlaceholder?: string;
  searchable?: boolean;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  dense?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const needle = search.trim().toLowerCase();
    return rows.filter((row) =>
      columns.some((column) => {
        const value = column.value?.(row);
        return value !== null && value !== undefined && String(value).toLowerCase().includes(needle);
      }),
    );
  }, [rows, search, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const column = columns.find((candidate) => candidate.key === sortKey);
    if (!column?.value) return filtered;

    return [...filtered].sort((a, b) => {
      const left = column.value?.(a);
      const right = column.value?.(b);
      // Nulls sort last regardless of direction: an unknown value is not "lowest".
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      const comparison =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right), undefined, { numeric: true });
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filtered, sortKey, sortDirection, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
    setPage(1);
  };

  return (
    <div className="card overflow-hidden">
      {searchable || toolbar ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          {searchable ? (
            <div className="relative min-w-[14rem] flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder={searchPlaceholder}
                className="h-8 pl-8 text-xs"
                aria-label={searchPlaceholder}
              />
            </div>
          ) : (
            <div />
          )}
          {toolbar ? <div className="flex items-center gap-2">{toolbar}</div> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="data-grid">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={column.className}
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={
                    sortKey === column.key
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  {column.sortable && column.value ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {column.header}
                      {sortKey === column.key ? (
                        sortDirection === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, index) => (
                  <tr key={`skeleton-${index}`}>
                    {columns.map((column) => (
                      <td key={column.key}>
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      onRowClick && 'cursor-pointer',
                      dense && 'text-xs',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((column) => (
                      <td key={column.key} className={column.className}>
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {!loading && visible.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden />}
          title={search ? 'No rows match your search' : emptyTitle}
          description={search ? undefined : emptyDescription}
        />
      ) : null}

      {sorted.length > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span>
            {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, sorted.length)} of{' '}
            {sorted.length}
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              className="h-7 text-xs"
              aria-label="Rows per page"
            >
              {[25, 50, 100, 200].map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              disabled={safePage <= 1}
              onClick={() => setPage((current) => current - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <span>
              {safePage} / {totalPages}
            </span>
            <Button
              size="icon"
              variant="ghost"
              disabled={safePage >= totalPages}
              onClick={() => setPage((current) => current + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
