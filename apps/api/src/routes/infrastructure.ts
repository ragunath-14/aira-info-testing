import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { environmentSchema, providerResourceIdSchema } from '@airaos/validation';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as digitalocean from '../providers/digitalocean/service.js';
import * as proxmox from '../providers/proxmox/service.js';
import * as operations from '../services/operations.js';

/**
 * DigitalOcean and Proxmox read routes.
 *
 * Every list is filtered to the caller's visible environments inside the service
 * layer, and every detail route re-resolves the resource so an id belonging to an
 * environment the caller cannot see returns 404 rather than data.
 *
 * Nothing here proxies a provider API: the routes expose the console's mapped
 * domain model only.
 */

const listQuerySchema = z.object({
  environment: environmentSchema.optional(),
  search: z.string().max(200).optional(),
});

export async function registerDigitalOceanRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: app.requirePermission('digitalocean.view') };

  app.get('/droplets', guard, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(listQuerySchema, request.query);
    const result = await digitalocean.listDroplets(user, query);

    noStore(reply);
    return ok(
      request,
      {
        items: result.value,
        // Surfaced so the UI can show "last successful sync" during an outage.
        stale: result.stale,
      },
      { cachedAgeMs: result.cachedAgeMs },
    );
  });

  app.get('/droplets/:dropletId', guard, async (request, reply) => {
    const user = requireUser(request);
    const { dropletId } = parse(
      z.object({ dropletId: providerResourceIdSchema }),
      request.params,
    );

    const detail = await digitalocean.getDropletDetail(user, dropletId);
    const capabilities = operations.capabilities(user, detail.droplet.environment).filter((entry) =>
      entry.key.endsWith('_droplet'),
    );

    noStore(reply);
    return ok(request, { ...detail, capabilities });
  });

  app.get('/droplets/:dropletId/metrics', guard, async (request, reply) => {
    const user = requireUser(request);
    const { dropletId } = parse(z.object({ dropletId: providerResourceIdSchema }), request.params);
    const { rangeMinutes } = parse(
      z.object({ rangeMinutes: z.coerce.number().int().min(5).max(10_080).default(60) }),
      request.query,
    );

    const result = await digitalocean.getDropletMetrics(user, dropletId, rangeMinutes);
    noStore(reply);
    return ok(request, result.value, { cachedAgeMs: result.cachedAgeMs });
  });

  app.get('/volumes', guard, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await digitalocean.listVolumes() });
  });

  app.get('/firewalls', guard, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await digitalocean.listFirewalls() });
  });

  app.get('/snapshots', guard, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await digitalocean.listSnapshots() });
  });

  app.get('/floating-ips', guard, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await digitalocean.listFloatingIps() });
  });

  /** Polls a DigitalOcean action so the UI can follow a reboot to completion. */
  app.get('/actions/:actionId', guard, async (request, reply) => {
    const { actionId } = parse(
      z.object({ actionId: z.string().regex(/^\d+$/, 'Invalid action id') }),
      request.params,
    );
    noStore(reply);
    return ok(request, await digitalocean.pollAction(actionId));
  });
}

export async function registerProxmoxRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: app.requirePermission('proxmox.view') };

  app.get('/overview', guard, async (request, reply) => {
    const user = requireUser(request);
    const [inventory, nodes] = await Promise.all([
      proxmox.getInventory(user),
      proxmox.getNodes(user),
    ]);

    noStore(reply);
    return ok(
      request,
      {
        cluster: inventory.value.cluster,
        nodes,
        guests: inventory.value.guests,
        stale: inventory.stale,
      },
      { cachedAgeMs: inventory.cachedAgeMs },
    );
  });

  app.get('/guests', guard, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(
      listQuerySchema.extend({
        node: z.string().max(100).optional(),
        type: z.enum(['qemu', 'lxc']).optional(),
      }),
      request.query,
    );

    const result = await proxmox.listGuests(user, query);
    noStore(reply);
    return ok(request, { items: result.value, stale: result.stale }, { cachedAgeMs: result.cachedAgeMs });
  });

  app.get('/guests/:vmid', guard, async (request, reply) => {
    const user = requireUser(request);
    const { vmid } = parse(
      z.object({ vmid: z.coerce.number().int().min(100).max(999_999_999) }),
      request.params,
    );

    const detail = await proxmox.getGuestDetail(user, vmid);
    const capabilities = operations
      .capabilities(user, detail.guest.environment)
      .filter((entry) => entry.key.endsWith('_vm'));

    noStore(reply);
    return ok(request, { ...detail, capabilities });
  });

  app.get('/storage', guard, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await proxmox.listStorage() });
  });

  /** Follows a Proxmox task (UPID) so the UI can report completion. */
  app.get('/tasks/:node/:upid', guard, async (request, reply) => {
    const { node, upid } = parse(
      z.object({
        node: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
        upid: z.string().min(1).max(300).regex(/^UPID:[A-Za-z0-9:._-]+$/, 'Invalid UPID'),
      }),
      request.params,
    );

    noStore(reply);
    return ok(request, await proxmox.getTaskStatus(node, upid));
  });
}

/**
 * Network view: the addresses and firewall rules the console knows about, pulled
 * from both providers. Read-only; there is no route that changes networking.
 */
export async function registerNetworkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: app.requirePermission('infra.view') }, async (request, reply) => {
    const user = requireUser(request);
    const allowed = visibleEnvironments(user);

    // Configuration now resolves from the Connection Manager, so these are async.
    const [doConfigured, pveConfigured] = await Promise.all([
      digitalocean.configured(),
      proxmox.configured(),
    ]);

    const [droplets, floatingIps, firewalls, proxmoxInventory] = await Promise.all([
      doConfigured
        ? digitalocean.listDroplets(user).then((result) => result.value).catch(() => [])
        : Promise.resolve([]),
      doConfigured ? digitalocean.listFloatingIps().catch(() => []) : Promise.resolve([]),
      doConfigured ? digitalocean.listFirewalls().catch(() => []) : Promise.resolve([]),
      pveConfigured
        ? proxmox.getInventory(user).then((result) => result.value).catch(() => null)
        : Promise.resolve(null),
    ]);

    const addresses = [
      ...droplets.flatMap((droplet) => [
        ...(droplet.networks.publicIpv4
          ? [
              {
                address: droplet.networks.publicIpv4,
                scope: 'public' as const,
                resource: droplet.name,
                resourceKind: 'droplet' as const,
                environment: droplet.environment,
                region: droplet.region.slug,
              },
            ]
          : []),
        ...(droplet.networks.privateIpv4
          ? [
              {
                address: droplet.networks.privateIpv4,
                scope: 'private' as const,
                resource: droplet.name,
                resourceKind: 'droplet' as const,
                environment: droplet.environment,
                region: droplet.region.slug,
              },
            ]
          : []),
      ]),
      ...(proxmoxInventory?.guests ?? []).flatMap((guest) =>
        guest.ipAddresses.map((address) => ({
          address,
          scope: 'private' as const,
          resource: guest.name,
          resourceKind: 'proxmox_guest' as const,
          environment: guest.environment,
          region: guest.node,
        })),
      ),
    ].filter((entry) => allowed.includes(entry.environment));

    noStore(reply);
    return ok(request, {
      addresses,
      floatingIps,
      firewalls,
      // Cluster inventory does not carry guest addresses: resolving them costs
      // one agent call per guest, so it happens on the guest detail page. Say so
      // rather than letting a short list imply the network is empty.
      note:
        proxmoxInventory && proxmoxInventory.guests.length > 0
          ? 'Proxmox guest addresses are resolved per guest (QEMU agent or static LXC config) and appear on the guest detail page.'
          : null,
    });
  });
}
