import type { Environment } from './environment.js';

/**
 * Permission catalogue (spec section 29). Permissions are the only unit the
 * backend checks; roles are named bundles that resolve to these strings.
 */
export const PERMISSIONS = [
  'infra.view',
  'infra.manage',

  'digitalocean.view',
  'digitalocean.reboot',
  'digitalocean.power',
  'digitalocean.snapshot',

  'proxmox.view',
  'proxmox.manage',

  'application.view',
  'application.restart',
  'application.deploy',
  'application.deploy.production',

  'database.view',
  'database.query',
  'database.write',
  'database.admin',

  'logs.view',
  'logs.export',

  'alerts.view',
  'alerts.manage',

  'audit.view',

  'users.view',
  'users.manage',

  'settings.view',
  'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export const ROLES = [
  'owner',
  'infrastructure_admin',
  'developer',
  'database_admin',
  'viewer',
  'intern',
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleDefinition {
  key: Role;
  label: string;
  description: string;
  permissions: readonly Permission[];
  /**
   * Environments this role may act in at all. An effective grant is the
   * intersection of permission and environment, so a developer holding
   * `application.restart` still cannot restart a production service.
   */
  environments: readonly Environment[];
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  owner: {
    key: 'owner',
    label: 'Owner',
    description: 'Full access across every environment, including production writes.',
    permissions: PERMISSIONS,
    environments: ['development', 'testing', 'staging', 'production'],
  },
  infrastructure_admin: {
    key: 'infrastructure_admin',
    label: 'Infrastructure Admin',
    description: 'Infrastructure operations and deployments in all environments.',
    permissions: [
      'infra.view',
      'infra.manage',
      'digitalocean.view',
      'digitalocean.reboot',
      'digitalocean.power',
      'digitalocean.snapshot',
      'proxmox.view',
      'proxmox.manage',
      'application.view',
      'application.restart',
      'application.deploy',
      'application.deploy.production',
      'database.view',
      'database.query',
      'logs.view',
      'logs.export',
      'alerts.view',
      'alerts.manage',
      'audit.view',
      'users.view',
      'settings.view',
    ],
    environments: ['development', 'testing', 'staging', 'production'],
  },
  developer: {
    key: 'developer',
    label: 'Developer',
    description: 'Manages development, testing and staging. Production stays read-only.',
    permissions: [
      'infra.view',
      'digitalocean.view',
      'proxmox.view',
      'proxmox.manage',
      'application.view',
      'application.restart',
      'application.deploy',
      'database.view',
      'database.query',
      'database.write',
      'logs.view',
      'alerts.view',
      'settings.view',
    ],
    environments: ['development', 'testing', 'staging'],
  },
  database_admin: {
    key: 'database_admin',
    label: 'Database Admin',
    description: 'Full database management, including audited production writes.',
    permissions: [
      'infra.view',
      'digitalocean.view',
      'proxmox.view',
      'application.view',
      'database.view',
      'database.query',
      'database.write',
      'database.admin',
      'logs.view',
      'alerts.view',
      'audit.view',
    ],
    environments: ['development', 'testing', 'staging', 'production'],
  },
  viewer: {
    key: 'viewer',
    label: 'Viewer',
    description: 'Read-only access to every environment.',
    permissions: [
      'infra.view',
      'digitalocean.view',
      'proxmox.view',
      'application.view',
      'database.view',
      'logs.view',
      'alerts.view',
    ],
    environments: ['development', 'testing', 'staging', 'production'],
  },
  intern: {
    key: 'intern',
    label: 'Intern',
    description: 'Read-only access to approved non-production resources only.',
    permissions: [
      'infra.view',
      'digitalocean.view',
      'proxmox.view',
      'application.view',
      'logs.view',
    ],
    environments: ['development', 'testing'],
  },
};

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  /** Flattened effective permissions, always computed server-side. */
  permissions: Permission[];
  /** Environments the user may act in, always computed server-side. */
  environments: Environment[];
  mfaVerified: boolean;
  sessionId: string;
  sessionExpiresAt: string;
}
