'use client';

import type { HealthState } from '@airaos/types';
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Health presentation.
 *
 * `unknown` is rendered distinctly from `healthy` everywhere — an unmonitored
 * service must never look like a passing one.
 */

const HEALTH_PRESENTATION: Record<
  HealthState,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; Icon: typeof CheckCircle2 }
> = {
  healthy: { label: 'Healthy', tone: 'success', Icon: CheckCircle2 },
  degraded: { label: 'Degraded', tone: 'warning', Icon: AlertTriangle },
  down: { label: 'Down', tone: 'danger', Icon: XCircle },
  unknown: { label: 'Not reported', tone: 'neutral', Icon: CircleHelp },
};

export function HealthBadge({
  state,
  label,
  className,
}: {
  state: HealthState;
  label?: string;
  className?: string;
}) {
  const presentation = HEALTH_PRESENTATION[state];
  return (
    <Badge tone={presentation.tone} className={className}>
      <presentation.Icon className="h-3 w-3" aria-hidden />
      {label ?? presentation.label}
    </Badge>
  );
}

/** Compact dot for dense tables, with the state also in the title attribute. */
export function HealthDot({ state, className }: { state: HealthState; className?: string }) {
  const colours: Record<HealthState, string> = {
    healthy: 'bg-success',
    degraded: 'bg-warning',
    down: 'bg-destructive',
    unknown: 'bg-muted-foreground/40',
  };

  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        colours[state],
        state === 'down' && 'animate-pulse-ring',
        className,
      )}
      title={HEALTH_PRESENTATION[state].label}
      aria-label={HEALTH_PRESENTATION[state].label}
      role="img"
    />
  );
}

/** Maps a provider status string onto a health state for consistent rendering. */
export function stateFromRunning(status: string): HealthState {
  switch (status) {
    case 'active':
    case 'running':
      return 'healthy';
    case 'off':
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'down';
    case 'restarting':
    case 'paused':
    case 'suspended':
    case 'new':
    case 'created':
      return 'degraded';
    default:
      return 'unknown';
  }
}

/**
 * Threshold colouring for a metric value. Returns a text class, or the muted
 * class when the value is missing — an uncollected metric is never green.
 */
export function metricTone(
  value: number | null,
  warnAbove: number | null,
  criticalAbove: number | null,
): string {
  if (value === null) return 'text-muted-foreground';
  if (criticalAbove !== null && value >= criticalAbove) return 'text-destructive';
  if (warnAbove !== null && value >= warnAbove) return 'text-warning';
  return 'text-foreground';
}
