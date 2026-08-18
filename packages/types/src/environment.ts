/**
 * Every resource in the console belongs to exactly one environment. The
 * environment drives guardrails (RBAC scoping, database write policy), so it is
 * a first-class type rather than a free-form string.
 */
export const ENVIRONMENTS = ['development', 'testing', 'staging', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}

/** Ordered least to most sensitive. Used for "at least this sensitive" checks. */
export const ENVIRONMENT_RANK: Record<Environment, number> = {
  development: 0,
  testing: 1,
  staging: 2,
  production: 3,
};

export interface EnvironmentPresentation {
  label: string;
  /** Short label for dense UI (tables, breadcrumbs). */
  short: string;
  /** Lucide icon name resolved by the web app. */
  icon: string;
  tone: 'emerald' | 'amber' | 'sky' | 'rose';
}

/**
 * Colour is never the only signal: every environment also carries a text label
 * and an icon so the UI stays unambiguous for colour-blind users (spec section 6).
 */
export const ENVIRONMENT_PRESENTATION: Record<Environment, EnvironmentPresentation> = {
  development: { label: 'Development', short: 'DEV', icon: 'wrench', tone: 'emerald' },
  testing: { label: 'Testing', short: 'TEST', icon: 'flask-conical', tone: 'amber' },
  staging: { label: 'Staging', short: 'STAGE', icon: 'layers', tone: 'sky' },
  production: { label: 'Production', short: 'PROD', icon: 'shield-alert', tone: 'rose' },
};
