import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser, Role } from '@airaos/types';
import { PERMISSIONS, ROLE_DEFINITIONS } from '@airaos/types';
import {
  assertConfirmation,
  assertOperationAllowed,
  authoriseOperation,
  can,
  resolveGrants,
  visibleEnvironments,
} from '../../src/rbac/index.js';
import { AppError } from '../../src/utils/errors.js';

/**
 * RBAC is what stops a developer from touching production (rules 9-12), so these
 * tests assert the intersection behaviour explicitly rather than just checking a
 * permission is present.
 */

function userWith(roles: Role[]): AuthenticatedUser {
  const grants = resolveGrants(roles);
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'operator@airaos.test',
    name: 'Operator',
    roles,
    permissions: [...grants.permissions],
    environments: [...grants.environments],
    mfaVerified: true,
    sessionId: 'session',
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe('resolveGrants', () => {
  it('gives owner every permission and every environment', () => {
    const grants = resolveGrants(['owner']);
    expect(grants.permissions.size).toBe(PERMISSIONS.length);
    expect([...grants.environments].sort()).toEqual([
      'development',
      'production',
      'staging',
      'testing',
    ]);
  });

  it('excludes production from a developer', () => {
    expect(resolveGrants(['developer']).environments.has('production')).toBe(false);
  });

  it('limits an intern to development and testing', () => {
    expect([...resolveGrants(['intern']).environments].sort()).toEqual(['development', 'testing']);
  });

  it('unions multiple roles', () => {
    const grants = resolveGrants(['intern', 'database_admin']);
    expect(grants.environments.has('production')).toBe(true);
    expect(grants.permissions.has('database.admin')).toBe(true);
  });

  it('ignores an unknown role rather than throwing', () => {
    const grants = resolveGrants(['not_a_role' as Role]);
    expect(grants.permissions.size).toBe(0);
  });
});

describe('can — permission intersected with environment', () => {
  const developer = userWith(['developer']);

  it('allows a held permission in a permitted environment', () => {
    expect(can(developer, 'application.restart', 'staging')).toBe(true);
  });

  it('refuses a held permission in a forbidden environment', () => {
    // This is the core guarantee: holding the permission is not enough.
    expect(can(developer, 'application.restart', 'production')).toBe(false);
  });

  it('refuses a permission the role does not hold', () => {
    expect(can(developer, 'users.manage', 'development')).toBe(false);
  });

  it('checks the permission alone when no environment is supplied', () => {
    expect(can(developer, 'application.restart')).toBe(true);
  });
});

describe('visibleEnvironments', () => {
  it('returns environments ordered least to most sensitive', () => {
    expect(visibleEnvironments(userWith(['owner']))).toEqual([
      'development',
      'testing',
      'staging',
      'production',
    ]);
  });
});

describe('authoriseOperation', () => {
  it('refuses an operation the console never permits in that environment', () => {
    // stop_vm is development/testing only, whatever the role.
    const decision = authoriseOperation(userWith(['owner']), 'stop_vm', 'production');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not available in production/i);
  });

  it('refuses when the role cannot act in the environment', () => {
    const decision = authoriseOperation(userWith(['developer']), 'restart_service', 'production');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/does not permit actions in production/i);
  });

  it('refuses when the base permission is missing', () => {
    const decision = authoriseOperation(userWith(['viewer']), 'restart_service', 'development');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/application\.restart/);
  });

  it('requires the production permission for a production deployment', () => {
    const developer = userWith(['developer']);
    expect(developer.permissions).toContain('application.deploy');
    // Developers cannot act in production at all, so this is refused earlier.
    expect(authoriseOperation(developer, 'deploy_release', 'production').allowed).toBe(false);

    const admin = userWith(['infrastructure_admin']);
    expect(authoriseOperation(admin, 'deploy_release', 'production').allowed).toBe(true);
  });

  it('refuses production database write mode without database.admin', () => {
    // database_admin holds it; a plain developer does not, and also cannot reach
    // production.
    expect(
      authoriseOperation(userWith(['database_admin']), 'activate_database_write_mode', 'production')
        .allowed,
    ).toBe(true);
    expect(
      authoriseOperation(userWith(['developer']), 'activate_database_write_mode', 'production')
        .allowed,
    ).toBe(false);
  });

  it('reports the confirmation requirements alongside the decision', () => {
    const decision = authoriseOperation(userWith(['owner']), 'reboot_droplet', 'production');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresTypedConfirmation).toBe(true);
  });

  it('refuses an unknown operation key', () => {
    const decision = authoriseOperation(
      userWith(['owner']),
      'not_an_operation' as never,
      'development',
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('assertOperationAllowed', () => {
  it('throws an OPERATION_NOT_ALLOWED error with the reason', () => {
    try {
      assertOperationAllowed(userWith(['viewer']), 'reboot_droplet', 'development');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('OPERATION_NOT_ALLOWED');
    }
  });

  it('does not throw for an allowed operation', () => {
    expect(() =>
      assertOperationAllowed(userWith(['owner']), 'reboot_droplet', 'production'),
    ).not.toThrow();
  });
});

describe('assertConfirmation', () => {
  it('accepts an exact match, ignoring surrounding whitespace', () => {
    expect(() => assertConfirmation('airaos-api', '  airaos-api  ')).not.toThrow();
  });

  it('rejects a prefix of the resource name', () => {
    // Guards against confirming "airaos-api" when the target is the worker.
    try {
      assertConfirmation('airaos-api-worker', 'airaos-api');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('CONFIRMATION_MISMATCH');
    }
  });

  it('rejects a missing confirmation with a prompt', () => {
    try {
      assertConfirmation('airaos-api', undefined);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('CONFIRMATION_REQUIRED');
      expect((error as AppError).message).toContain('airaos-api');
    }
  });

  it('rejects an empty confirmation', () => {
    expect(() => assertConfirmation('airaos-api', '   ')).toThrow(AppError);
  });
});

describe('role definitions', () => {
  it('never grants a non-production role production access', () => {
    for (const role of ['developer', 'intern'] as const) {
      expect(ROLE_DEFINITIONS[role].environments).not.toContain('production');
    }
  });

  it('keeps every declared permission inside the catalogue', () => {
    for (const definition of Object.values(ROLE_DEFINITIONS)) {
      for (const permission of definition.permissions) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('does not grant users.manage to anyone but owner', () => {
    const holders = Object.values(ROLE_DEFINITIONS)
      .filter((definition) => definition.permissions.includes('users.manage'))
      .map((definition) => definition.key);
    expect(holders).toEqual(['owner']);
  });
});
