'use client';

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Environment, OperationKey, OperationResult } from '@airaos/types';
import { api, ApiClientError } from '@/lib/api-client';
import type { ConfirmRequest } from '@/components/shared/confirm-dialog';

/**
 * Drives the confirm-then-execute flow for allowlisted operations.
 *
 * Every operation the UI can trigger goes through this hook and the single
 * /operations endpoint, so the confirmation dialog, the environment check and
 * the audit trail behave identically no matter which page invoked it.
 */

export interface OperationTarget {
  operationKey: OperationKey;
  resourceId: string;
  environment: Environment;
  resourceLabel: string;
  title: string;
  description: string;
  impact: ConfirmRequest['impact'];
  requiresTypedConfirmation: boolean;
  requiresSecondApproval: boolean;
  warnings?: string[];
  confirmLabel?: string;
  /** Extra fields the operation needs, e.g. a version to deploy. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Query keys to invalidate once the operation is accepted. */
  invalidate?: string[][];
}

export function useOperation() {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<OperationTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<OperationResult | null>(null);

  const request = useCallback((next: OperationTarget) => {
    setError(null);
    setLastResult(null);
    setTarget(next);
  }, []);

  const cancel = useCallback(() => {
    if (submitting) return;
    setTarget(null);
    setError(null);
  }, [submitting]);

  const confirm = useCallback(
    async (input: { confirmation?: string; reason?: string }) => {
      if (!target) return;
      setSubmitting(true);
      setError(null);

      try {
        const result = await api.post<OperationResult>('operations', {
          key: target.operationKey,
          resourceId: target.resourceId,
          environment: target.environment,
          confirmation: input.confirmation,
          reason: input.reason,
          metadata: target.metadata,
        });

        setLastResult(result);
        setTarget(null);

        for (const key of target.invalidate ?? []) {
          await queryClient.invalidateQueries({ queryKey: key });
        }
      } catch (caught) {
        // The API's message is written for an operator, so it is shown verbatim.
        setError(
          caught instanceof ApiClientError
            ? caught.message
            : 'The operation could not be completed.',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [target, queryClient],
  );

  const confirmRequest: ConfirmRequest | null = target
    ? {
        operationKey: target.operationKey,
        title: target.title,
        description: target.description,
        environment: target.environment,
        resourceLabel: target.resourceLabel,
        impact: target.impact,
        requiresTypedConfirmation: target.requiresTypedConfirmation,
        requiresSecondApproval: target.requiresSecondApproval,
        warnings: target.warnings,
        confirmLabel: target.confirmLabel,
      }
    : null;

  return {
    confirmRequest,
    open: target !== null,
    submitting,
    error,
    lastResult,
    request,
    cancel,
    confirm,
    dismissResult: () => setLastResult(null),
  };
}
