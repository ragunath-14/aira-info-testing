import type { Environment } from './environment.js';
import type { Permission } from './rbac.js';

/**
 * The complete set of operations the console can perform (spec section 40).
 * There is no generic execute endpoint: an operation key maps to one known
 * backend routine, and anything not in this list cannot be run at all.
 */
export const OPERATION_KEYS = [
  'restart_service',
  'start_service',
  'stop_service',
  'restart_worker',
  'deploy_release',
  'approve_production_deployment',
  'rollback_release',
  'reboot_droplet',
  'power_on_droplet',
  'power_off_droplet',
  'snapshot_droplet',
  'start_vm',
  'shutdown_vm',
  'reboot_vm',
  'stop_vm',
  'snapshot_vm',
  'acknowledge_alert',
  'activate_database_write_mode',
] as const;

export type OperationKey = (typeof OPERATION_KEYS)[number];

export type OperationImpact = 'none' | 'brief_interruption' | 'service_downtime' | 'data_changing';

export interface OperationDefinition {
  key: OperationKey;
  label: string;
  /** Shown verbatim in the confirmation dialog. */
  description: string;
  requiredPermission: Permission;
  /** Extra permission required when the target is production. */
  productionPermission: Permission | null;
  impact: OperationImpact;
  /** Environments in which this operation may ever run. */
  allowedEnvironments: readonly Environment[];
  /** Operator must retype the resource name before the action is enabled. */
  requiresTypedConfirmation: boolean;
  /** A second authorised user must approve before execution. */
  requiresSecondApproval: boolean;
  resourceKind: 'application' | 'container' | 'droplet' | 'proxmox_guest' | 'deployment' | 'alert' | 'database';
}

export const OPERATION_DEFINITIONS: Record<OperationKey, OperationDefinition> = {
  restart_service: {
    key: 'restart_service',
    label: 'Restart service',
    description: 'Restarts the container backing this service. In-flight requests are dropped.',
    requiredPermission: 'application.restart',
    productionPermission: 'application.restart',
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'application',
  },
  start_service: {
    key: 'start_service',
    label: 'Start service',
    description: 'Starts a stopped container for this service.',
    requiredPermission: 'application.restart',
    productionPermission: 'application.restart',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'application',
  },
  stop_service: {
    key: 'stop_service',
    label: 'Stop service',
    description: 'Stops the container. The service stays down until started again.',
    requiredPermission: 'application.restart',
    productionPermission: 'infra.manage',
    impact: 'service_downtime',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'application',
  },
  restart_worker: {
    key: 'restart_worker',
    label: 'Restart worker',
    description: 'Restarts a background worker. Jobs in progress are retried per queue policy.',
    requiredPermission: 'application.restart',
    productionPermission: 'application.restart',
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'application',
  },
  deploy_release: {
    key: 'deploy_release',
    label: 'Deploy release',
    description: 'Deploys a CI-built release to this environment.',
    requiredPermission: 'application.deploy',
    productionPermission: 'application.deploy.production',
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: true,
    resourceKind: 'deployment',
  },
  approve_production_deployment: {
    key: 'approve_production_deployment',
    label: 'Approve production deployment',
    description: 'Approves a pending production deployment so it can proceed.',
    requiredPermission: 'application.deploy.production',
    productionPermission: 'application.deploy.production',
    impact: 'none',
    allowedEnvironments: ['production'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'deployment',
  },
  rollback_release: {
    key: 'rollback_release',
    label: 'Roll back release',
    description: 'Redeploys the previous known-good release for this service.',
    requiredPermission: 'application.deploy',
    productionPermission: 'application.deploy.production',
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'deployment',
  },
  reboot_droplet: {
    key: 'reboot_droplet',
    label: 'Reboot droplet',
    description: 'Graceful reboot of the droplet. Everything hosted on it is interrupted.',
    requiredPermission: 'digitalocean.reboot',
    productionPermission: 'digitalocean.reboot',
    // A reboot comes back on its own, so this is an interruption rather than
    // downtime — `service_downtime` copy promises it stays down until started
    // again, which would be wrong here. Matches reboot_vm.
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'droplet',
  },
  power_on_droplet: {
    key: 'power_on_droplet',
    label: 'Power on droplet',
    description: 'Powers on a droplet that is currently off.',
    requiredPermission: 'digitalocean.power',
    productionPermission: 'digitalocean.power',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'droplet',
  },
  power_off_droplet: {
    key: 'power_off_droplet',
    label: 'Power off droplet',
    description: 'Hard power off. Anything running on the droplet stops immediately.',
    requiredPermission: 'digitalocean.power',
    productionPermission: 'infra.manage',
    impact: 'service_downtime',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: true,
    resourceKind: 'droplet',
  },
  snapshot_droplet: {
    key: 'snapshot_droplet',
    label: 'Snapshot droplet',
    description: 'Creates a droplet snapshot. The droplet may be briefly slower while it runs.',
    requiredPermission: 'digitalocean.snapshot',
    productionPermission: 'digitalocean.snapshot',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'droplet',
  },
  start_vm: {
    key: 'start_vm',
    label: 'Start VM / container',
    description: 'Starts a stopped Proxmox guest.',
    requiredPermission: 'proxmox.manage',
    productionPermission: 'infra.manage',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'proxmox_guest',
  },
  shutdown_vm: {
    key: 'shutdown_vm',
    label: 'Shut down VM / container',
    description: 'Requests a graceful guest OS shutdown.',
    requiredPermission: 'proxmox.manage',
    productionPermission: 'infra.manage',
    impact: 'service_downtime',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'proxmox_guest',
  },
  reboot_vm: {
    key: 'reboot_vm',
    label: 'Reboot VM / container',
    description: 'Graceful guest reboot.',
    requiredPermission: 'proxmox.manage',
    productionPermission: 'infra.manage',
    impact: 'brief_interruption',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'proxmox_guest',
  },
  stop_vm: {
    key: 'stop_vm',
    label: 'Stop VM / container (hard)',
    description: 'Immediate stop without a guest shutdown. Risks unflushed writes.',
    requiredPermission: 'proxmox.manage',
    productionPermission: 'infra.manage',
    impact: 'service_downtime',
    allowedEnvironments: ['development', 'testing'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: true,
    resourceKind: 'proxmox_guest',
  },
  snapshot_vm: {
    key: 'snapshot_vm',
    label: 'Snapshot VM / container',
    description: 'Creates a Proxmox snapshot of the guest.',
    requiredPermission: 'proxmox.manage',
    productionPermission: 'infra.manage',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'proxmox_guest',
  },
  acknowledge_alert: {
    key: 'acknowledge_alert',
    label: 'Acknowledge alert',
    description: 'Records that you own this alert. It does not silence the underlying condition.',
    requiredPermission: 'alerts.manage',
    productionPermission: 'alerts.manage',
    impact: 'none',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: false,
    requiresSecondApproval: false,
    resourceKind: 'alert',
  },
  activate_database_write_mode: {
    key: 'activate_database_write_mode',
    label: 'Activate database write mode',
    description:
      'Opens a time-limited write window on this connection. Every statement is logged.',
    requiredPermission: 'database.write',
    productionPermission: 'database.admin',
    impact: 'data_changing',
    allowedEnvironments: ['development', 'testing', 'staging', 'production'],
    requiresTypedConfirmation: true,
    requiresSecondApproval: false,
    resourceKind: 'database',
  },
};

export interface OperationRequest {
  key: OperationKey;
  /** Server resolves this against the registry; never trusted as-is. */
  resourceId: string;
  environment: Environment;
  /** Typed confirmation value, compared server-side against the resource name. */
  confirmation?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface OperationResult {
  key: OperationKey;
  resourceId: string;
  environment: Environment;
  accepted: boolean;
  status: 'completed' | 'in_progress' | 'rejected' | 'failed' | 'awaiting_approval';
  /** Provider action id where one exists (DO action, Proxmox UPID). */
  providerActionId: string | null;
  message: string;
  auditEventId: string;
  startedAt: string;
  finishedAt: string | null;
}
