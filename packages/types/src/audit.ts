import type { Environment } from './environment.js';
import type { Role } from './rbac.js';

export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditEvent {
  id: string;
  sequence: number;
  userId: string;
  userEmail: string;
  userRoles: Role[];
  /** Machine-readable action, e.g. RESTART_SERVICE or EXECUTE_SQL. */
  action: string;
  resourceKind: string;
  resourceId: string | null;
  resourceLabel: string | null;
  environment: Environment | null;
  result: AuditResult;
  errorCode: string | null;
  /** Sanitised message. Contains no credentials or stack traces. */
  message: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
  /** Non-sensitive structured context. Values are redacted before insert. */
  metadata: Record<string, unknown>;
  occurredAt: string;
  /** Chain hash over the previous record; makes silent edits detectable. */
  recordHash: string;
  previousHash: string | null;
}

export interface AuditQuery {
  userId?: string;
  action?: string;
  resourceKind?: string;
  environment?: Environment;
  result?: AuditResult;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface AuditChainVerification {
  verified: boolean;
  checkedCount: number;
  /** Sequence number of the first record whose hash does not match. */
  firstBrokenSequence: number | null;
  checkedAt: string;
}
