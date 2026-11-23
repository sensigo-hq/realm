// The REAL invariant: read-only commands never gain the capability to EXECUTE project
// code. Two structural assertions enforce it:
//  1. read-only command sources never reference the extensions LOADER module
//     (load-project-extensions — the only module that dynamic-imports project code);
//  2. `inspect` MAY reference the pure fingerprint module (extension-identity — drift
//     evidence rendering + --check-drift recomputation), and that module's source must
//     itself contain no code-loading capability: no dynamic `import(`, no `createRequire`.
// Pure hashing over bytes is allowed in read-only commands; loading is not.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_REF = 'load-project-extensions';
const IDENTITY_MODULE_PATH = join(COMMANDS_DIR, '..', 'extensions', 'extension-identity.ts');
// #828 unit 1: the realm-mcp module that holds the dir_tree_v1 sweep and the per-process map.
const CODE_HASHES_SPECIFIER = '@sensigo/realm-mcp/code-hashes';
const CODE_HASHES_PATH = join(
  COMMANDS_DIR,
  '..',
  '..',
  '..',
  'mcp-server',
  'src',
  'code-hashes.ts',
);

function source(name: string): string {
  return readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf8');
}

/** The module specifiers a source imports or re-exports statically (`from '…'` and `import '…'`). */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom|^\s*import)\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

/** Every non-test `.ts` source under `dir`, recursively. */
function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
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

  it('the manifest/secrets modules satisfy the same invariant (no dynamic import, no createRequire, no secret resolution capability leak into read-only paths)', () => {
    // manifest-secrets.ts is pure fs+parse; the CORE manifest modules are pure data/shape.
    const secretsSource = readFileSync(
      join(COMMANDS_DIR, '..', 'extensions', 'manifest-secrets.ts'),
      'utf8',
    );
    expect(secretsSource).not.toMatch(/\bimport\s*\(/);
    expect(secretsSource).not.toContain('createRequire');
    // Read-only commands must not import the secrets engine at all.
    for (const name of ['replay', 'inspect', 'list', 'diff', 'replay-format']) {
      expect(source(name)).not.toContain('manifest-secrets');
    }
  });

  // #828 unit 1 (check 8): the code's hashes live in the realm-mcp subpath `code-hashes`, which the
  // pure identity module imports. That module loads no code either, and imports only `node:` modules
  // and `@sensigo/realm`; the CLI reaches it by exactly the subpath, never the package root (whose
  // graph is the whole server) or `/internal`.
  it('#828: the hashing module imports only node: modules and @sensigo/realm, and has no dynamic import(…) and no createRequire', () => {
    const hashes = readFileSync(CODE_HASHES_PATH, 'utf8');
    const outside = specifiers(hashes).filter(
      (s) => !s.startsWith('node:') && s !== '@sensigo/realm',
    );
    // (1) red when it imports anything else, or gains a dynamic import or a createRequire;
    //     (2) prints the specifiers outside the two and what was found.
    expect({
      outside,
      dynamicImport: /\bimport\s*\(/.test(hashes),
      createRequire: hashes.includes('createRequire'),
    }).toEqual({ outside: [], dynamicImport: false, createRequire: false });
  });

  it('#828: the CLI imports the hashing module by exactly @sensigo/realm-mcp/code-hashes, and the identity module imports no other realm-mcp entry', () => {
    const cliSources = listSources(join(COMMANDS_DIR, '..'));
    const viaOther = cliSources.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((s) => s.includes('code-hashes') && s !== CODE_HASHES_SPECIFIER)
        .map((s) => `${file}: ${s}`),
    );
    const identityRealmMcp = specifiers(readFileSync(IDENTITY_MODULE_PATH, 'utf8')).filter((s) =>
      s.startsWith('@sensigo/realm-mcp'),
    );
    // (1) red when the identity module imports the realm-mcp root or `/internal` (their graphs load
    //     code), or any CLI file reaches code-hashes by another path; (2) prints what it found.
    expect({ viaOther, identityRealmMcp }).toEqual({
      viaOther: [],
      identityRealmMcp: [CODE_HASHES_SPECIFIER],
    });
  });

  it('sanity: inspect references the pure identity module (drift rendering is wired)', () => {
    expect(source('inspect')).toContain('extension-identity');
  });

  it.each(['run', 'agent', 'listen', 'serve', 'mcp', 'validate', 'test', 'register', 'watch'])(
    'sanity: %s.ts references the loader (directly or via a shared helper)',
    (name) => {
      const text = source(name);
      const wired =
        text.includes(LOADER_REF) ||
        text.includes('loadWorkflowForRegistration') ||
        text.includes('load-workflow-for-admission');
      expect(wired).toBe(true);
    },
  );
});
