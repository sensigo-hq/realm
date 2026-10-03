// The one line `realm mcp` and `realm serve` print when realm cannot build or run their MCP server
// (issue #620 PR-C round 4, walk R1).
//
// These two commands hand `createRealmMcpServer` only stores this CLI built itself. So when its
// refusal is a release-line refusal (`ENGINE_RELEASE_LINE_MISMATCH` / `_UNDECLARED`) naming
// `createRealmMcpServer`, the command's own install is split — the engine's "Hand realm a store
// from …" names an act the operator of these commands cannot take. The CLI renders its own line
// from the refusal's typed `details` (a host fact); the engine's message stays the engine's. Any
// other error keeps the line these commands always printed: `realm <command>: <message>`.
//
// The refusal comes from realm-mcp's copy of `@sensigo/realm`, which is not this CLI's copy when
// the install is split — so it is read by its fields, never by `instanceof`. Every read is inside a
// `try`: this is total.
import { describeThrown } from '@sensigo/realm';

const RELEASE_LINE_CODES = new Set([
  'ENGINE_RELEASE_LINE_MISMATCH',
  'ENGINE_RELEASE_LINE_UNDECLARED',
]);

/** `the workflow store handed to createRealmMcpServer` → `workflow store`; else `undefined`. */
const CONSTRUCTION_ROLE = /^the (.+) handed to createRealmMcpServer$/;

const REINSTALL =
  'Reinstall @sensigo/realm-cli so every @sensigo package it installs is one version (npm ls -g ' +
  '@sensigo/realm lists the copies of a global install; npm ls @sensigo/realm in a project).';

interface OwnPackagesFacts {
  code: string;
  noun: string;
  localVersion: string;
  localPath: string;
  foreignVersion?: string;
  foreignPath?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The facts of a release-line refusal raised by `createRealmMcpServer`, or `undefined`. */
function ownPackagesFacts(err: unknown): OwnPackagesFacts | undefined {
  try {
    if (typeof err !== 'object' || err === null) return undefined;
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string' || !RELEASE_LINE_CODES.has(code)) return undefined;
    const details = (err as { details?: unknown }).details;
    if (typeof details !== 'object' || details === null) return undefined;
    const d = details as Record<string, unknown>;
    const role = stringField(d, 'role');
    const noun = role === undefined ? undefined : CONSTRUCTION_ROLE.exec(role)?.[1];
    const localVersion = stringField(d, 'local_version');
    const localPath = stringField(d, 'local_path');
    if (noun === undefined || localVersion === undefined || localPath === undefined) {
      return undefined;
    }
    if (code === 'ENGINE_RELEASE_LINE_UNDECLARED') {
      return { code, noun, localVersion, localPath };
    }
    const foreignVersion = stringField(d, 'foreign_version');
    const foreignPath = stringField(d, 'foreign_path');
    if (foreignVersion === undefined || foreignPath === undefined) return undefined;
    return { code, noun, localVersion, localPath, foreignVersion, foreignPath };
  } catch {
    return undefined;
  }
}

/**
 * The one line `realm <command>` prints for an error raised while it builds or runs its MCP
 * server. Newlines collapsed: one line.
 */
export function hostRefusalLine(command: 'mcp' | 'serve', err: unknown): string {
  const f = ownPackagesFacts(err);
  if (f === undefined) {
    return `realm ${command}: ${describeThrown(err).replace(/\s*\n\s*/g, ' ')}`;
  }
  const handed =
    f.foreignVersion !== undefined
      ? `was handed a ${f.noun} from @sensigo/realm ${f.foreignVersion} (${f.foreignPath})`
      : `was handed a ${f.noun} that carries no realm release mark, so it comes from a copy of ` +
        '@sensigo/realm too old to mark its classes';
  const line =
    `realm ${command}: this realm command's own packages disagree: its realm-mcp runs ` +
    `@sensigo/realm ${f.localVersion} (${f.localPath}) and ${handed}. ${REINSTALL}`;
  return line.replace(/\s*\n\s*/g, ' ');
}
