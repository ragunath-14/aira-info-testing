'use client';

import { ENVIRONMENT_PRESENTATION, type Environment } from '@airaos/types';
import { FlaskConical, Layers, ShieldAlert, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Environment badge (spec section 6, rule 12).
 *
 * Three independent signals, deliberately: colour, an icon, and the text label.
 * A colour-blind operator, a greyscale screenshot and a screen reader all still
 * make production unmistakable.
 */

const ICONS: Record<Environment, typeof Wrench> = {
  development: Wrench,
  testing: FlaskConical,
  staging: Layers,
  production: ShieldAlert,
};

export function EnvironmentBadge({
  environment,
  size = 'md',
  showFullLabel = false,
  className,
}: {
  environment: Environment;
  size?: 'sm' | 'md';
  showFullLabel?: boolean;
  className?: string;
}) {
  const presentation = ENVIRONMENT_PRESENTATION[environment];
  const Icon = ICONS[environment];

  return (
    <span
      className={cn(
        `env-${environment}`,
        'tone-surface inline-flex items-center gap-1 rounded border font-semibold uppercase tracking-wide',
        size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-xs',
        className,
      )}
      // Spelled out for screen readers even when the visual label is abbreviated.
      aria-label={`${presentation.label} environment`}
      title={`${presentation.label} environment`}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden />
      {showFullLabel ? presentation.label : presentation.short}
    </span>
  );
}

/**
 * Full-width banner shown at the top of any page scoped to production, and above
 * any dangerous action. Loud on purpose.
 */
export function EnvironmentBanner({
  environment,
  message,
  className,
}: {
  environment: Environment;
  message?: string;
  className?: string;
}) {
  const presentation = ENVIRONMENT_PRESENTATION[environment];
  const Icon = ICONS[environment];

  return (
    <div
      className={cn(
        `env-${environment}`,
        'tone-surface flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
        className,
      )}
      role={environment === 'production' ? 'alert' : 'status'}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-semibold uppercase tracking-wide">{presentation.label}</span>
      {message ? <span className="opacity-90">— {message}</span> : null}
    </div>
  );
}

/** Coloured left border for cards and table rows scoped to one environment. */
export function environmentAccent(environment: Environment): string {
  return cn(`env-${environment}`, 'border-l-2');
}
