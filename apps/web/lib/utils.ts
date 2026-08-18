import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Byte formatter used across metric cards and table sizes. */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-GB').format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(decimals)}%`;
}

/** Compact duration for uptimes and ages. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;

  const months = Math.floor(days / 30);
  return `${months}mo ${days % 30}d`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Relative time, e.g. "4m ago". Absolute timestamps stay in tooltips. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const deltaSeconds = Math.round((Date.now() - then) / 1000);
  if (Math.abs(deltaSeconds) < 10) return 'just now';

  const future = deltaSeconds < 0;
  const magnitude = Math.abs(deltaSeconds);
  const suffix = future ? 'from now' : 'ago';

  if (magnitude < 60) return `${magnitude}s ${suffix}`;
  if (magnitude < 3600) return `${Math.round(magnitude / 60)}m ${suffix}`;
  if (magnitude < 86_400) return `${Math.round(magnitude / 3600)}h ${suffix}`;
  return `${Math.round(magnitude / 86_400)}d ${suffix}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function truncate(value: string, length = 60): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/** Short commit sha for display. */
export function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

/**
 * Renders an unknown cell value for the data grid. Objects become JSON, nulls
 * become a visible marker rather than an empty cell, so "null" and "empty
 * string" stay distinguishable.
 */
export function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false };
  const text = String(value);
  return { text: text === '' ? '(empty)' : text, isNull: false };
}
