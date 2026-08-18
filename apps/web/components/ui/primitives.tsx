'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Minimal shadcn-style primitives. Hand-written rather than generated so the
 * console has no build-time dependency on a component CLI, and so every variant
 * here is one the console actually uses.
 */

// -------------------------------------------------------------------- button --

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'border border-border bg-surface hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // Reserved for actions that stop or destroy something.
        danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outlineDanger:
          'border border-destructive/50 text-destructive hover:bg-destructive/10',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4',
        lg: 'h-10 px-6',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// --------------------------------------------------------------------- card --

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

// -------------------------------------------------------------------- badge --

const badgeVariants = cva(
  // whitespace-nowrap because a pill that wraps becomes a tall blob rather than a
  // badge; callers that need long text should use a banner instead.
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-2xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-destructive/30 bg-destructive/10 text-destructive',
        info: 'border-info/30 bg-info/10 text-info',
        outline: 'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// -------------------------------------------------------------------- input --

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 rounded-md border border-input bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('block text-xs font-medium text-muted-foreground', className)} {...props}>
      {children}
    </label>
  );
}

// ------------------------------------------------------------------ feedback --

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} aria-hidden />;
}

/** Empty state. Always says why a list is empty, never just "no data". */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-border', className)} role="separator" />;
}

/**
 * Key-value row used throughout detail panels. `mono` is for identifiers, IPs
 * and shas, where character alignment matters.
 */
export function Field({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-sm', mono && 'mono')} title={title}>
        {value}
      </span>
    </div>
  );
}
