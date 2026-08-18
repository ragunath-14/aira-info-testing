import type { Environment } from './environment.js';
import type { HealthState } from './infrastructure.js';

export type ApplicationKind = 'api' | 'web' | 'worker' | 'service' | 'cron';

export interface ApplicationRegistryEntry {
  id: string;
  key: string;
  name: string;
  kind: ApplicationKind;
  environment: Environment;
  /** Logical host or provider resource the service runs on. */
  host: string | null;
  containerName: string | null;
  repository: string | null;
  branch: string | null;
  version: string | null;
  commitSha: string | null;
  /** Absolute URL the console probes. Must live on an internal network. */
  healthUrl: string | null;
  port: number | null;
  dependsOn: string[];
  ownerTeam: string | null;
  /** Restart/deploy operations are only offered when the app opts in. */
  operationsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HealthProbeResult {
  state: HealthState;
  httpStatus: number | null;
  responseTimeMs: number | null;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Sanitised message. Provider/stack detail is stripped before it leaves the API. */
  message: string | null;
  dependencies: Array<{ name: string; state: HealthState; detail: string | null }>;
}

export interface ApplicationStatus {
  application: ApplicationRegistryEntry;
  health: HealthProbeResult;
  container: ContainerStatus | null;
  lastDeployment: DeploymentSummary | null;
}

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  imageTag: string | null;
  state: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'unknown';
  healthStatus: 'healthy' | 'unhealthy' | 'starting' | 'none';
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  restartCount: number;
  startedAt: string | null;
  uptimeSeconds: number | null;
  ports: Array<{ container: number; host: number | null; protocol: string }>;
}

export type DeploymentStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'cancelled';

export interface DeploymentSummary {
  id: string;
  applicationId: string;
  applicationKey: string;
  environment: Environment;
  version: string;
  commitSha: string;
  branch: string | null;
  status: DeploymentStatus;
  triggeredByUserId: string;
  triggeredByEmail: string;
  approvedByUserId: string | null;
  approvedByEmail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** External CI run this deployment corresponds to. */
  ciRunUrl: string | null;
  rollbackOfDeploymentId: string | null;
  message: string | null;
}

export interface ReleaseCandidate {
  version: string;
  commitSha: string;
  branch: string;
  createdAt: string;
  ciStatus: 'passed' | 'failed' | 'running' | 'unknown';
  ciRunUrl: string | null;
  /** Whether this release has already been validated in a lower environment. */
  promotedFrom: Environment | null;
}
