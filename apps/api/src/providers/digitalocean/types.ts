/**
 * Wire types for the DigitalOcean v2 API. Only the fields the console actually
 * reads are declared; everything else is ignored so a provider-side addition
 * cannot change our behaviour.
 */

export interface DoRegion {
  slug: string;
  name: string;
  available: boolean;
  sizes: string[];
  features: string[];
}

export interface DoSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_monthly: number | null;
  price_hourly: number | null;
  available: boolean;
  description: string;
}

export interface DoImage {
  id: number;
  name: string;
  distribution: string | null;
  slug: string | null;
  type: string;
}

export interface DoNetworkV4 {
  ip_address: string;
  netmask: string;
  gateway: string;
  type: 'public' | 'private';
}

export interface DoNetworkV6 {
  ip_address: string;
  netmask: number;
  gateway: string;
  type: string;
}

export interface DoDroplet {
  id: number;
  name: string;
  memory: number;
  vcpus: number;
  disk: number;
  locked: boolean;
  status: 'new' | 'active' | 'off' | 'archive';
  created_at: string;
  features: string[];
  backup_ids: number[];
  next_backup_window: { start: string; end: string } | null;
  snapshot_ids: number[];
  image: DoImage;
  size: DoSize;
  size_slug: string;
  networks: { v4: DoNetworkV4[]; v6: DoNetworkV6[] };
  region: DoRegion;
  tags: string[];
  vpc_uuid: string | null;
}

export interface DoAction {
  id: number;
  status: 'in-progress' | 'completed' | 'errored';
  type: string;
  started_at: string;
  completed_at: string | null;
  resource_id: number;
  resource_type: string;
  region_slug: string | null;
}

export interface DoVolumeWire {
  id: string;
  name: string;
  size_gigabytes: number;
  region: DoRegion;
  droplet_ids: number[];
  filesystem_type: string | null;
  created_at: string;
}

export interface DoFirewallWire {
  id: string;
  name: string;
  status: string;
  inbound_rules: Array<{
    protocol: string;
    ports: string;
    sources: { addresses?: string[]; droplet_ids?: number[]; tags?: string[]; load_balancer_uids?: string[] };
  }>;
  outbound_rules: Array<{
    protocol: string;
    ports: string;
    destinations: { addresses?: string[]; droplet_ids?: number[]; tags?: string[] };
  }>;
  droplet_ids: number[];
  tags: string[];
}

export interface DoSnapshotWire {
  id: string;
  name: string;
  resource_id: string;
  resource_type: 'droplet' | 'volume';
  min_disk_size: number;
  size_gigabytes: number;
  regions: string[];
  created_at: string;
}

export interface DoFloatingIpWire {
  ip: string;
  region: DoRegion;
  droplet: DoDroplet | null;
  locked: boolean;
}

/** Prometheus-style response used by the DigitalOcean monitoring endpoints. */
export interface DoMetricsResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      values: Array<[number, string]>;
    }>;
  };
}

export interface DoDatabaseCluster {
  id: string;
  name: string;
  engine: string;
  version: string;
  status: string;
  region: string;
  size: string;
  num_nodes: number;
  created_at: string;
  connection: { host: string; port: number; database: string; user: string; ssl: boolean } | null;
  maintenance_window: { day: string; hour: string; pending: boolean } | null;
  tags: string[];
}

export interface DoDatabaseBackup {
  created_at: string;
  size_gigabytes: number;
}

export interface DoListMeta {
  total: number;
}

export interface DoLinks {
  pages?: { next?: string; last?: string; prev?: string; first?: string };
}
