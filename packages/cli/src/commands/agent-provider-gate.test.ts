// issue #620 PR-C — U4: the provider gate says which LlmProvider it was handed. `foreign_line` is driven
// on a real two-copy layout (multi-copy row 10.5); the two kinds below need no layout.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

function gate(moduleSource: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'realm-u4-'));
  const home = mkdtempSync(join(tmpdir(), 'realm-u4-home-'));
  const file = join(dir, 'provider.mjs');
  writeFileSync(file, moduleSource, 'utf8');
  try {
    const r = spawnSync(
      process.execPath,
      [CLI, 'agent', '--workflow', join(dir, 'none.yaml'), '--provider-module', file],
      { cwd: dir, env: { PATH: process.env['PATH'] ?? '', HOME: home }, encoding: 'utf8' },
    );
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const TODAY_SECOND =
  "Import LlmProvider from '@sensigo/realm-cli/agent' and export 'export default new MyProvider()'.";

describe('U4 — the provider gate', () => {
  it('unbranded_copy: a same-named class with no mark — today’s two lines, the clause in place of the first line’s period', () => {
    const r = gate(
      'class LlmProvider {}\nclass Mine extends LlmProvider {}\nexport default new Mine();\n',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Error: provider module default export must be an instance extending LlmProvider — it looks like realm's LlmProvider by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name.\n" +
        `${TODAY_SECOND}\n`,
    );
  });
  it('not_realm: anything else — today’s two lines, unchanged', () => {
    const r = gate('export default { hello: 1 };\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      `Error: provider module default export must be an instance extending LlmProvider.\n${TODAY_SECOND}\n`,
    );
  });
});
