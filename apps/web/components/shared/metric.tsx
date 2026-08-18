'use client';

import type { MetricSummary, TimeSeries } from '@airaos/types';
import { CircleOff } from 'lucide-react';
import { formatBytes, formatMs, formatNumber, formatPercent } from '@/lib/utils';
import { metricTone } from '@/components/shared/status';
import { cn } from '@/lib/utils';

/**
 * Metric display.
 *
 * The important behaviour: a metric with no value renders as "not collected"
 * with a reason, never as zero. A missing exporter and an idle service must not
 * look the same (spec section 36).
 */

export function formatMetricValue(value: number | null, unit: MetricSummary['unit']): string {
  if (value === null) return '—';
  switch (unit) {
    case 'percent':
      return formatPercent(value);
    case 'bytes':
      return formatBytes(value);
    case 'ms':
      return formatMs(value);
    case 'seconds':
      return value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`;
    case 'rps':
      return `${value.toFixed(value < 10 ? 2 : 0)}/s`;
    case 'ratio':
      return value.toFixed(2);
    default:
      return formatNumber(value);
  }
}

export function MetricCard({ metric, className }: { metric: MetricSummary; className?: string }) {
  const unavailable = metric.unavailableReason !== null;

  return (
    <div className={cn('card p-3', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">{metric.label}</p>
        {unavailable ? <CircleOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : null}
      </div>

      {unavailable ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">Not collected</p>
          <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground" title={metric.unavailableReason ?? undefined}>
            {metric.unavailableReason}
          </p>
        </>
      ) : (
        <>
          <p
            className={cn(
              'mt-1 text-xl font-semibold tracking-tight',
              metricTone(metric.value, metric.warnAbove, metric.criticalAbove),
            )}
          >
            {formatMetricValue(metric.value, metric.unit)}
          </p>
          {metric.series && metric.series.length > 1 ? (
            <Sparkline
              series={metric.series}
              className="mt-2"
              tone={
                metric.criticalAbove !== null &&
                metric.value !== null &&
                metric.value >= metric.criticalAbove
                  ? 'danger'
                  : metric.warnAbove !== null &&
                      metric.value !== null &&
                      metric.value >= metric.warnAbove
                    ? 'warning'
                    : 'primary'
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Inline sparkline. Hand-rolled SVG rather than a charting library: one line of
 * one series does not justify the bundle, and this keeps the CSP free of any
 * external script.
 */
export function Sparkline({
  series,
  className,
  height = 32,
  tone = 'primary',
}: {
  series: TimeSeries;
  className?: string;
  height?: number;
  tone?: 'primary' | 'warning' | 'danger' | 'muted';
}) {
  if (series.length < 2) return null;

  const values = series.map((point) => point.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; render it as a centred line instead.
  const span = max - min || 1;
  const width = 100;

  const points = series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - ((point.v - min) / span) * (height - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const strokes: Record<typeof tone, string> = {
    primary: 'stroke-primary',
    warning: 'stroke-warning',
    danger: 'stroke-destructive',
    muted: 'stroke-muted-foreground',
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full', className)}
      style={{ height }}
      role="img"
      aria-label={`Trend from ${formatNumber(values[0] ?? null)} to ${formatNumber(values[values.length - 1] ?? null)}`}
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        className={strokes[tone]}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Horizontal usage bar for memory/disk figures with a known total. */
export function UsageBar({
  used,
  total,
  label,
  className,
}: {
  used: number | null;
  total: number | null;
  label?: string;
  className?: string;
}) {
  if (used === null || total === null || total <= 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const percent = Math.min(100, (used / total) * 100);
  const tone = percent >= 90 ? 'bg-destructive' : percent >= 75 ? 'bg-warning' : 'bg-primary';

  return (
    <div className={cn('min-w-[7rem]', className)}>
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span>{label ?? `${formatBytes(used)} / ${formatBytes(total)}`}</span>
        <span className={percent >= 90 ? 'font-medium text-destructive' : undefined}>
          {percent.toFixed(0)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Score ring used by the dashboard health headline. */
export function ScoreRing({
  score,
  size = 96,
  caption,
}: {
  score: number;
  size?: number;
  caption?: string;
}) {
  const radius = size / 2 - 6;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const tone = score >= 90 ? 'stroke-success' : score >= 70 ? 'stroke-warning' : 'stroke-destructive';

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} role="img" aria-label={`Health score ${score} out of 100`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="stroke-muted"
          strokeWidth={6}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className={tone}
          strokeWidth={6}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-lg font-semibold"
        >
          {score}
        </text>
      </svg>
      {caption ? <p className="max-w-[16rem] text-xs text-muted-foreground">{caption}</p> : null}
    </div>
  );
}
