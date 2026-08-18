/** Wire types for the Proxmox VE REST API (api2/json). */

export interface PveEnvelope<T> {
  data: T;
}

export interface PveNodeSummary {
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  level?: string;
  ssl_fingerprint?: string;
}

export interface PveNodeStatus {
  uptime: number;
  cpuinfo: { cpus: number; model: string; sockets: number };
  loadavg: string[];
  memory: { total: number; used: number; free: number };
  rootfs: { total: number; used: number; free: number; avail: number };
  swap: { total: number; used: number; free: number };
  pveversion: string;
  kversion: string;
}

export interface PveGuestSummary {
  vmid: number;
  name?: string;
  status: 'running' | 'stopped' | 'paused' | 'suspended';
  node?: string;
  cpu?: number;
  cpus?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  netin?: number;
  netout?: number;
  uptime?: number;
  template?: number | boolean;
  tags?: string;
  lock?: string;
  type?: 'qemu' | 'lxc';
  /** Present on /cluster/resources rows. */
  id?: string;
  hastate?: string;
}

export interface PveClusterStatusEntry {
  type: 'cluster' | 'node';
  id: string;
  name?: string;
  quorate?: number;
  nodes?: number;
  version?: number;
  online?: number;
  local?: number;
  ip?: string;
}

export interface PveSnapshot {
  name: string;
  snaptime?: number;
  description?: string;
  vmstate?: number;
  parent?: string;
}

export interface PveStorageEntry {
  storage: string;
  node?: string;
  type: string;
  content?: string;
  enabled?: number;
  active?: number;
  used?: number;
  total?: number;
  avail?: number;
  shared?: number;
}

export interface PveBackupTask {
  upid: string;
  node: string;
  type: string;
  status?: string;
  starttime: number;
  endtime?: number;
  exitstatus?: string;
  id?: string;
}

export interface PveAgentInterfaces {
  result: Array<{
    name: string;
    'hardware-address'?: string;
    'ip-addresses'?: Array<{ 'ip-address': string; 'ip-address-type': string; prefix: number }>;
  }>;
}

export interface PveLxcConfig {
  hostname?: string;
  tags?: string;
  /** net0..netN entries in "name=eth0,bridge=vmbr0,ip=10.0.0.5/24" form. */
  [key: string]: string | number | undefined;
}

export interface PveTaskStatus {
  upid: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
  node: string;
  type: string;
  starttime: number;
}
