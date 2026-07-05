// The REAL invariant: read-only commands never gain the capability to EXECUTE project
// code. Two structural assertions enforce it:
//  1. read-only command sources never reference the extensions LOADER module
//     (load-project-extensions — the only module that dynamic-imports project code);
//  2. `inspect` MAY reference the pure fingerprint module (extension-identity — drift
//     evidence rendering + --check-drift recomputation), and that module's source must
//     itself contain no code-loading capability: no dynamic `import(`, no `createRequire`.
// Pure hashing over bytes is allowed in read-only commands; loading is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_REF = 'load-project-extensions';
const IDENTITY_MODULE_PATH = join(COMMANDS_DIR, '..', 'extensions', 'extension-identity.ts');

function source(name: string): string {
  return readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf8');
}

describe('read-only commands never gain code-execution capability', () => {
  it.each(['replay', 'inspect', 'list', 'diff', 'replay-format'])(
    '%s.ts has no reference to the loader',
    (name) => {
      expect(source(name)).not.toContain(LOADER_REF);
    },
  );

  it('the pure identity module inspect uses contains no dynamic import(...)', () => {
    const identitySource = readFileSync(IDENTITY_MODULE_PATH, 'utf8');
    // Dynamic-import shape only — static `import { x } from` statements are fine.
    expect(identitySource).not.toMatch(/\bimport\s*\(/);
  });

  it('the pure identity module inspect uses contains no createRequire', () => {
    const identitySource = readFileSync(IDENTITY_MODULE_PATH, 'utf8');
    expect(identitySource).not.toContain('createRequire');
  });

  it('sanity: inspect references the pure identity module (drift rendering is wired)', () => {
    expect(source('inspect')).toContain('extension-identity');
  });

  it.each(['run', 'agent', 'listen', 'serve', 'mcp', 'validate', 'test', 'register', 'watch'])(
    'sanity: %s.ts references the loader (directly or via a shared helper)',
    (name) => {
      const text = source(name);
      const wired = text.includes(LOADER_REF) || text.includes('loadWorkflowForRegistration');
      expect(wired).toBe(true);
    },
  );
});
