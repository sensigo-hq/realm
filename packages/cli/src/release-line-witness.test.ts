// issue #620 PR-C — the two exact-count source-text witnesses (the #417 shape): every call site of
// `describeUnrecognised` and `assertReleaseLine` in non-test source, counted outside comments. A new
// call site, or a deleted one, changes a count and names the file.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './multi-copy/layout.js';
import {
  RUN_STORE_FIDELITY_LAWS,
  ARTIFACT_STORE_LAWS,
  FENCED_TRACE_BUFFER_LAWS,
  SETTLEMENT_LAWS,
} from '@sensigo/realm-testing';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Call sites of `name(` outside comments, per file; the definition itself is not a call. */
function callSites(name: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pkg of ['core', 'cli', 'mcp-server', 'testing']) {
    for (const file of sourceFiles(join(REPO_ROOT, 'packages', pkg, 'src'))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const n =
        (code.match(new RegExp(`\\b${name}\\(`, 'g')) ?? []).length -
        (code.match(new RegExp(`function ${name}\\(`, 'g')) ?? []).length;
      if (n > 0) counts[relative(REPO_ROOT, file)] = n;
    }
  }
  return counts;
}

describe('release-line witnesses', () => {
  it('describeUnrecognised: U1, U2, U7 (execution-loop), U4 (agent), U6 (cross-copy-note), the registry rule', () => {
    expect(callSites('describeUnrecognised')).toEqual({
      'packages/core/src/engine/execution-loop.ts': 3,
      'packages/cli/src/commands/agent.ts': 1,
      'packages/core/src/release-line.ts': 1,
      'packages/testing/src/store/cross-copy-note.ts': 1,
    });
  });
  it('assertReleaseLine: H1 (4), the tool entries (one helper), H2 (10 across five files), H3 (2)', () => {
    expect(callSites('assertReleaseLine')).toEqual({
      'packages/mcp-server/src/server.ts': 4,
      'packages/mcp-server/src/tools/assert-tool-stores.ts': 1,
      'packages/core/src/engine/execution-loop.ts': 5,
      'packages/core/src/engine/abandon-run.ts': 1,
      'packages/core/src/engine/reclaim-step.ts': 1,
      'packages/core/src/workflow/registrar.ts': 1,
      'packages/core/src/store/fence-predicate.ts': 1,
      'packages/core/src/store/trace-buffer-store.ts': 1,
      'packages/mcp-server/src/json-trace-buffer-store.ts': 1,
    });
  });
  it('every contract exports STORE_RELEASE_LINE_TRUE, every runner takes its laws from the export, and no runner keeps a hand-written law list (a law no runner executes passes vacuously)', () => {
    // (a) the four exported lists carry the law, so a runner that derives from its export runs it.
    for (const list of [
      RUN_STORE_FIDELITY_LAWS,
      ARTIFACT_STORE_LAWS,
      FENCED_TRACE_BUFFER_LAWS,
      SETTLEMENT_LAWS,
    ] as readonly (readonly string[])[]) {
      expect(list).toContain('STORE_RELEASE_LINE_TRUE');
    }
    // (b) every runner derives from an export and does not set the law aside in its NOT_RUN;
    // (c) no test file keeps its own array of law names — the shape that let
    //     `in-memory-store.test.ts` (`const laws = [...]`) skip this law on `main` while a check
    //     keyed on `const LAWS` looked elsewhere.
    const runners: string[] = [];
    const handLists: string[] = [];
    for (const pkg of ['core', 'cli', 'mcp-server', 'testing']) {
      for (const file of testFiles(join(REPO_ROOT, 'packages', pkg, 'src'))) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(REPO_ROOT, file);
        if (
          /\b(?:RUN_STORE_FIDELITY|ARTIFACT_STORE|FENCED_TRACE_BUFFER|SETTLEMENT)_LAWS\.filter\(/.test(
            text,
          )
        ) {
          runners.push(rel);
          const notRun = /const NOT_RUN[^=]*= \{([\s\S]*?)\};/.exec(text);
          expect(notRun?.[1] ?? '', rel).not.toContain('STORE_RELEASE_LINE_TRUE');
        }
        if (/const\s+(?:LAWS|laws)\b[^=]*=\s*\[\s*'[A-Z0-9_]+'/.test(text)) handLists.push(rel);
      }
    }
    expect(handLists).toEqual([]);
    expect(runners.sort()).toEqual([
      'packages/cli/src/store-contracts/failed-attempt-store.contract.test.ts',
      'packages/cli/src/store-contracts/in-memory-trace-buffer-store-fenced.contract.test.ts',
      'packages/cli/src/store-contracts/json-file-store.contract.test.ts',
      'packages/cli/src/store-contracts/json-trace-buffer-store-fenced.contract.test.ts',
      'packages/cli/src/store-contracts/json-trace-buffer-store.contract.test.ts',
      'packages/cli/src/store-contracts/run-store-fidelity.contract.test.ts',
      'packages/testing/src/store/in-memory-store.test.ts',
      'packages/testing/src/store/settlement-in-memory-store.test.ts',
      'packages/testing/src/store/settlement-json-file-store.test.ts',
    ]);
  });
  it('brand.ts still imports only ./version.js', () => {
    const text = readFileSync(join(REPO_ROOT, 'packages/core/src/brand.ts'), 'utf8');
    expect([...text.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual([
      './version.js',
    ]);
  });
});
