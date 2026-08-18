'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Permission } from '@airaos/types';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Boxes,
  Cloud,
  Container,
  Database,
  FileClock,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Network,
  Plug,
  Rocket,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Table2,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import { useSession } from '@/components/layout/session-provider';
import { cn } from '@/lib/utils';

/**
 * Primary navigation (spec section 44).
 *
 * Sections whose every item requires a permission the operator lacks are hidden
 * entirely rather than shown disabled: a nav full of dead links makes the console
 * feel broken. The API still enforces access if a URL is entered directly.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
}

interface NavSection {
  label: string | null;
  items: NavItem[];
}

const NAVIGATION: NavSection[] = [
  {
    label: null,
    items: [{ href: '/', label: 'Overview', icon: LayoutDashboard, permission: 'infra.view' }],
  },
  {
    label: 'Infrastructure',
    items: [
      { href: '/infrastructure/digitalocean', label: 'DigitalOcean', icon: Cloud, permission: 'digitalocean.view' },
      { href: '/infrastructure/proxmox', label: 'Proxmox', icon: Server, permission: 'proxmox.view' },
      { href: '/infrastructure/network', label: 'Network', icon: Network, permission: 'infra.view' },
    ],
  },
  {
    label: 'Applications',
    items: [
      { href: '/applications/services', label: 'Services', icon: Boxes, permission: 'application.view' },
      { href: '/applications/containers', label: 'Containers', icon: Container, permission: 'application.view' },
      { href: '/applications/deployments', label: 'Deployments', icon: Rocket, permission: 'application.view' },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { href: '/monitoring/metrics', label: 'Metrics', icon: BarChart3, permission: 'infra.view' },
      { href: '/monitoring/alerts', label: 'Alerts', icon: AlertTriangle, permission: 'alerts.view' },
      { href: '/monitoring/health', label: 'Health', icon: Activity, permission: 'infra.view' },
    ],
  },
  {
    label: null,
    items: [{ href: '/logs', label: 'Logs', icon: ScrollText, permission: 'logs.view' }],
  },
  {
    label: 'Database',
    items: [
      { href: '/database/connections', label: 'Connections', icon: Database, permission: 'database.view' },
      { href: '/database/explorer', label: 'Explorer', icon: HardDrive, permission: 'database.view' },
      { href: '/database/browser', label: 'Data Browser', icon: Table2, permission: 'database.view' },
      { href: '/database/sql', label: 'SQL Editor', icon: Terminal, permission: 'database.query' },
      { href: '/database/history', label: 'Query History', icon: FileClock, permission: 'database.view' },
    ],
  },
  {
    label: null,
    items: [{ href: '/redis', label: 'Redis', icon: Zap, permission: 'infra.view' }],
  },
  {
    label: 'Security',
    items: [
      { href: '/security/users', label: 'Users', icon: Users, permission: 'users.view' },
      { href: '/security/roles', label: 'Roles', icon: KeyRound, permission: 'users.view' },
      { href: '/security/audit', label: 'Audit Logs', icon: FileText, permission: 'audit.view' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings/connections', label: 'Connections', icon: Plug, permission: 'settings.view' },
      { href: '/settings', label: 'Console', icon: Settings, permission: 'settings.view' },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { can, loading } = useSession();

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <nav
      className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-surface-sunken"
      aria-label="Primary"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Gauge className="h-5 w-5 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">AIRAOS</p>
          <p className="truncate text-2xs uppercase tracking-wider text-muted-foreground">
            Infra Console
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {loading && sections.length === 0 ? (
          <div className="space-y-1 px-2" aria-hidden>
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="h-7 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : (
          sections.map((section, index) => (
            <div key={section.label ?? `section-${index}`} className="mb-3">
              {section.label ? (
                <p className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  // Exact match: every nav target is a leaf page, and a prefix
                  // match would light up /settings while on /settings/connections.
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border px-4 py-2">
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Monitoring-first. Operations are audited.
        </p>
      </div>
    </nav>
  );
}
