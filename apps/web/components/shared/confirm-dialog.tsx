'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Environment, OperationKey } from '@airaos/types';
import { AlertTriangle, X } from 'lucide-react';
import { Button, Input, Label, Textarea } from '@/components/ui/primitives';
import { EnvironmentBanner } from '@/components/shared/environment-badge';
import { cn } from '@/lib/utils';

/**
 * Confirmation dialog for dangerous operations (spec section 41).
 *
 * What it guarantees:
 *
 *  - The environment is stated in words at the top, so "I thought I was on
 *    staging" cannot survive the dialog (rule 12).
 *  - The expected impact is spelled out, not implied by a red button.
 *  - When the operation requires typed confirmation, the confirm button stays
 *    disabled until the resource name matches exactly. Client-side only as a
 *    courtesy — the API checks the same thing.
 *  - Production operations require a reason, which lands in the audit record.
 *  - Focus is trapped, Escape cancels, and nothing is pre-focused on the
 *    confirm button.
 */

export interface ConfirmRequest {
  operationKey: OperationKey;
  title: string;
  /** What the operation does, in plain language. */
  description: string;
  environment: Environment;
  resourceLabel: string;
  impact: 'none' | 'brief_interruption' | 'service_downtime' | 'data_changing';
  requiresTypedConfirmation: boolean;
  requiresSecondApproval: boolean;
  /** Extra warnings, e.g. inbound foreign keys or dependent services. */
  warnings?: string[];
  confirmLabel?: string;
}

const IMPACT_TEXT: Record<ConfirmRequest['impact'], string> = {
  none: 'No service interruption is expected.',
  brief_interruption: 'Expect a brief interruption while the service restarts.',
  service_downtime: 'The service will stop and stay down until it is started again.',
  data_changing: 'This changes data. It may not be reversible.',
};

export function ConfirmDialog({
  request,
  open,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest | null;
  open: boolean;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { confirmation?: string; reason?: string }) => void;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Reset between openings so a previous confirmation cannot be reused.
  useEffect(() => {
    if (open) {
      setTyped('');
      setReason('');
      // Focus lands on Cancel, never Confirm: an Enter keypress must not fire a
      // destructive action.
      cancelRef.current?.focus();
    }
  }, [open, request?.operationKey, request?.resourceLabel]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, onCancel]);

  if (!open || !request) return null;

  const isProduction = request.environment === 'production';
  const reasonRequired = isProduction && request.impact !== 'none';
  const confirmationMatches =
    !request.requiresTypedConfirmation || typed.trim() === request.resourceLabel.trim();
  const reasonSatisfied = !reasonRequired || reason.trim().length >= 10;
  const canConfirm = confirmationMatches && reasonSatisfied && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        // Backdrop click cancels, but only from the backdrop itself.
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="animate-fade-in w-full max-w-lg rounded-lg border border-border bg-surface-raised shadow-lg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className={cn('mt-0.5 h-4 w-4 shrink-0', isProduction ? 'text-destructive' : 'text-warning')}
              aria-hidden
            />
            <div>
              <h2 id={titleId} className="text-sm font-semibold">
                {request.title}
              </h2>
              <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
                {request.description}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <EnvironmentBanner
            environment={request.environment}
            message={isProduction ? 'This action affects production.' : undefined}
          />

          <dl className="space-y-1 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-xs text-muted-foreground">Resource</dt>
              <dd className="mono truncate">{request.resourceLabel}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-xs text-muted-foreground">Expected impact</dt>
              <dd className="text-right text-xs">{IMPACT_TEXT[request.impact]}</dd>
            </div>
          </dl>

          {request.requiresSecondApproval ? (
            <p className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              This action is recorded and then waits for a second authorised operator to approve it.
              Nothing happens until they do.
            </p>
          ) : null}

          {request.warnings?.length ? (
            <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {request.warnings.map((warning) => (
                <li key={warning}>• {warning}</li>
              ))}
            </ul>
          ) : null}

          {request.requiresTypedConfirmation ? (
            <div className="space-y-1">
              <Label htmlFor="confirm-typed">
                Type <span className="mono font-semibold">{request.resourceLabel}</span> to confirm
              </Label>
              <Input
                id="confirm-typed"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mono"
                aria-invalid={typed.length > 0 && !confirmationMatches}
              />
            </div>
          ) : null}

          {reasonRequired ? (
            <div className="space-y-1">
              <Label htmlFor="confirm-reason">
                Reason (recorded in the audit trail, at least 10 characters)
              </Label>
              <Textarea
                id="confirm-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Clearing a stuck worker queue after INC-1042"
              />
            </div>
          ) : null}

          {error ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={isProduction || request.impact === 'service_downtime' ? 'danger' : 'primary'}
            disabled={!canConfirm}
            loading={submitting}
            onClick={() =>
              onConfirm({
                confirmation: request.requiresTypedConfirmation ? typed.trim() : undefined,
                reason: reason.trim() || undefined,
              })
            }
          >
            {request.confirmLabel ?? request.title}
          </Button>
        </div>
      </div>
    </div>
  );
}
