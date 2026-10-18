// engines.ts — #790 (D12): condition 3, `root_engine` — can this login reach an engine that runs
// containers or machines as root? A connect to each engine's socket (W's Docker sockets, and LXD,
// Incus, Podman, libvirt and containerd), and membership of the groups that reach one or the disks,
// read both from `getent group` and from this process's own groups: membership outlasts a stopped or
// renamed socket.
import type { ConditionReading } from '@sensigo/realm';
import { join } from 'node:path';
import type { Lookups } from './lookup.js';

/** D12's sockets, by engine; each from its project's own source or docs (F790-IA rows). */
const SOCKETS: readonly [engine: string, path: string][] = [
  ['Docker', '/var/run/docker.sock'],
  ['LXD', '/var/snap/lxd/common/lxd/unix.socket'],
  ['LXD', '/var/lib/lxd/unix.socket'],
  ['Incus', '/var/lib/incus/unix.socket'],
  ['Incus', '/run/incus/unix.socket'],
  ['Podman', '/run/podman/podman.sock'],
  ['libvirt', '/var/run/libvirt/libvirt-sock'],
  ['libvirt', '/run/libvirt/virtqemud-sock'],
  ['containerd', '/run/containerd/containerd.sock'],
];
/** D12's groups: each reaches an engine, or the disks. */
export const ROOT_GROUPS = ['disk', 'docker', 'lxd', 'incus-admin', 'libvirt'] as const;

/** Condition 3 (D12, D13): measured "no" only when no socket accepts and this login is in none of
 *  the groups. */
export async function rootEngineReach(lk: Lookups): Promise<ConditionReading> {
  const { probes } = lk;
  const targets: { engine: string; target: { path: string } | { host: string; port: number } }[] =
    [];
  const dockerHost = probes.env['DOCKER_HOST'];
  if (dockerHost !== undefined && dockerHost !== '') {
    if (dockerHost.startsWith('unix://'))
      targets.push({ engine: 'Docker', target: { path: dockerHost.slice('unix://'.length) } });
    const tcp = /^tcp:\/\/([^:/]+):(\d+)/.exec(dockerHost);
    if (tcp !== null)
      targets.push({ engine: 'Docker', target: { host: tcp[1]!, port: Number(tcp[2]) } });
  }
  const home = probes.loginHome();
  const own =
    home !== undefined
      ? [
          join(home, '.docker', 'run', 'docker.sock'),
          join(home, '.docker', 'desktop', 'docker.sock'),
        ]
      : [];
  for (const [engine, path] of [...SOCKETS, ...own.map((p) => ['Docker', p] as const)]) {
    if (probes.exists(path)) targets.push({ engine, target: { path } });
  }
  for (const { engine, target } of targets) {
    if (await probes.connect(target)) {
      const where = 'path' in target ? target.path : `${target.host}:${target.port}`;
      return { basis: 'measured', answer: 'yes', detail: `${engine}'s socket ${where} accepts` };
    }
  }
  const unread: string[] = [];
  for (const group of ROOT_GROUPS) {
    const m = await lk.loginIn(group);
    if ('found' in m && m.found) {
      return { basis: 'measured', answer: 'yes', detail: `this login is in the group ${group}` };
    }
    if ('unknown' in m) unread.push(m.unknown);
  }
  // Correction 2 (5.2): with no login home, the login's own sockets were never looked at.
  if (home === undefined) {
    return {
      basis: 'unknown',
      cause:
        "this login's home could not be read: it has no passwd entry, so its own Docker sockets were not checked",
    };
  }
  if (unread.length > 0) {
    return {
      basis: 'unknown',
      cause: `the groups that reach a root engine were not read: ${unread[0]}`,
    };
  }
  return { basis: 'measured', answer: 'no' };
}
