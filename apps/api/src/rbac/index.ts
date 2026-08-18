import {
  ENVIRONMENT_RANK,
  OPERATION_DEFINITIONS,
  ROLE_DEFINITIONS,
  type AuthenticatedUser,
  type Environment,
  type OperationKey,
  type Permission,
  type Role,
} from '@airaos/types';
import { errors } from '../utils/errors.js';

/**
 * Authorisation decisions (spec section 29, rules 9-12).
 *
 * The backend is the only authority: the frontend hides controls a user cannot
 * use, but every route re-derives the same answer here from the session's roles.
 * Nothing in this module reads request-supplied permissions or environments.
 */

export interface EffectiveGrants {
  permissions: Set<Permission>;
  environments: Set<Environment>;
}

/** Flattens roles into the permission and environment sets they imply. */
export function resolveGrants(roles: Role[]): EffectiveGrants {
  const permissions = new Set<Permission>();
  const environments = new Set<Environment>();

  for (const role of roles) {
    const definition = ROLE_DEFINITIONS[role];
    if (!definition) continue;
    for (const permission of definition.permissions) permissions.add(permission);
    for (const environment of definition.environments) environments.add(environment);
  }

  return { permissions, environments };
}

export function hasPermission(user: AuthenticatedUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function hasEnvironment(user: AuthenticatedUser, environment: Environment): boolean {
  return user.environments.includes(environment);
}

/**
 * The core check: a permission is only effective inside an environment the
 * user's roles cover. This is what stops a developer with
 * `application.restart` from restarting production.
 */
export function can(
  user: AuthenticatedUser,
  permission: Permission,
  environment?: Environment,
): boolean {
  if (!hasPermission(user, permission)) return false;
  if (environment && !hasEnvironment(user, environment)) return false;
  return true;
}

export function assertPermission(
  user: AuthenticatedUser,
  permission: Permission,
  environment?: Environment,
): void {
  if (!hasPermission(user, permission)) {
    throw errors.forbidden(
      `This action requires the ${permission} permission.`,
      { permission, roles: user.roles },
    );
  }
  if (environment && !hasEnvironment(user, environment)) {
    throw errors.environmentForbidden(environment);
  }
}

/**
 * Filters a list of environments down to those the user may see. Used by list
 * endpoints so an intern's request for "all droplets" silently excludes
 * production rather than erroring.
 */
export function visibleEnvironments(user: AuthenticatedUser): Environment[] {
  return [...user.environments].sort((a, b) => ENVIRONMENT_RANK[a] - ENVIRONMENT_RANK[b]);
}

export interface OperationAuthorisation {
  allowed: boolean;
  reason: string | null;
  requiresTypedConfirmation: boolean;
  requiresSecondApproval: boolean;
}

/**
 * Authorises one allowlisted operation against a resource's environment.
 *
 * Three gates must all pass: the operation must be permitted in that
 * environment at all, the user must hold the base permission, and for
 * production the user must additionally hold the operation's production
 * permission.
 */
export function authoriseOperation(
  user: AuthenticatedUser,
  key: OperationKey,
  environment: Environment,
): OperationAuthorisation {
  const definition = OPERATION_DEFINITIONS[key];
  if (!definition) {
    return {
      allowed: false,
      reason: 'Unknown operation.',
      requiresTypedConfirmation: false,
      requiresSecondApproval: false,
    };
  }

  const base = {
    requiresTypedConfirmation: definition.requiresTypedConfirmation,
    requiresSecondApproval: definition.requiresSecondApproval,
  };

  if (!definition.allowedEnvironments.includes(environment)) {
    return {
      ...base,
      allowed: false,
      reason: `${definition.label} is not available in ${environment}. This is a console-wide policy, not a permission.`,
    };
  }

  if (!hasEnvironment(user, environment)) {
    return {
      ...base,
      allowed: false,
      reason: `Your role does not permit actions in ${environment}.`,
    };
  }

  if (!hasPermission(user, definition.requiredPermission)) {
    return {
      ...base,
      allowed: false,
      reason: `${definition.label} requires the ${definition.requiredPermission} permission.`,
    };
  }

  if (
    environment === 'production' &&
    definition.productionPermission &&
    !hasPermission(user, definition.productionPermission)
  ) {
    return {
      ...base,
      allowed: false,
      reason: `Production ${definition.label.toLowerCase()} requires the ${definition.productionPermission} permission.`,
    };
  }

  return { ...base, allowed: true, reason: null };
}

export function assertOperationAllowed(
  user: AuthenticatedUser,
  key: OperationKey,
  environment: Environment,
): void {
  const decision = authoriseOperation(user, key, environment);
  if (!decision.allowed) {
    throw errors.operationNotAllowed(decision.reason ?? 'Operation not allowed.', {
      operation: key,
      environment,
      roles: user.roles,
    });
  }
}

/**
 * Typed confirmation check (spec section 41). Comparison is exact after trimming
 * so an operator cannot confirm "airaos-api" when the target is
 * "airaos-api-worker".
 */
export function assertConfirmation(expected: string, provided: string | undefined): void {
  if (provided === undefined || provided.trim().length === 0) {
    throw errors.confirmationRequired(expected);
  }
  if (provided.trim() !== expected.trim()) {
    throw errors.confirmationMismatch();
  }
}
