// issue #620 PR-C — the advisory where project code loads (in-process): the walk-up, the cached
// result, the default sink's once-per-copy rule, the collecting sink, listen's logger, the facts.
// A "copy" here is only a `node_modules/@sensigo/realm/package.json`: the loader reads it by path
// and never imports it, and the modules themselves import nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  REALM_BRAND,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  clearProjectExtensionsCache,
  clearReleaseLineSinkMemory,
  collectReleaseLineWarnings,
  loadProjectExtensions,
  makeRegistryProvider,
} from './load-project-extensions.js';
import { prepareListenWorkflows } from '../commands/listen.js';

const ENGINE_VERSION = REALM_BRAND.version;
const ENGINE_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');

let root: string;
let counter = 0;

function fakeRealm(dir: string, version: string): string {
  const pkg = join(dir, 'node_modules', '@sensigo', 'realm');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@sensigo/realm', version }));
  return pkg;
}

/** Writes `n` modules under `dir`, each registering one uniquely named handler. */
function modules(dir: string, n: number): string[] {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `h_${counter}_${i}`;
    const file = join(dir, `m-${Date.now()}-${counter++}.mjs`);
    writeFileSync(
      file,
      `export default { handlers: { ${name}: { id: '${name}', execute: async () => ({ data: {} }) } } };\n`,
    );
    out.push(file);
  }
  return out;
}

function definition(id: string, files: string[]): WorkflowDefinition {
  const workflowDir = join(root, 'workflows', id);
  mkdirSync(workflowDir, { recursive: true });
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: workflowDir,
    trust_root: root,
    extensions: files.map((f) => f),
  } as WorkflowDefinition;
}

function advisoryFor(version: string, path: string, by: string): string {
  return (
    `⚠ Your project's @sensigo/realm is ${version} (${path}, installed by ${by}); this realm command runs @sensigo/realm ${ENGINE_VERSION}. ` +
    `Realm objects do not cross versions: a WorkflowError your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. ` +
    `Install @sensigo/realm@${ENGINE_VERSION} (and every other @sensigo package the project has, at ${ENGINE_VERSION}) in the project your code imports it from, or, when you run the realm command, run version ${version} there: npm install --save-dev @sensigo/realm-cli@${version}, then npx realm.`
  );
}

beforeEach(() => {
  clearProjectExtensionsCache();
  clearReleaseLineSinkMemory();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-advisory-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the default sink', () => {
  it('ten modules on one copy print one line, whole message; a second load (cache hit) prints nothing more; stdout untouched', async () => {
    const copy = fakeRealm(root, '9.9.9');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const def = definition('ten', modules(join(root, 'code'), 10));
    await loadProjectExtensions(def);
    await loadProjectExtensions(def);
    expect(errors.mock.calls).toEqual([[advisoryFor('9.9.9', copy, 'the project')]]);
    expect(log).not.toHaveBeenCalled();
  });

  it('two copies print two lines', async () => {
    fakeRealm(root, '9.9.9');
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    fakeRealm(sub, '8.8.8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadProjectExtensions(
      definition('two', [...modules(join(root, 'code'), 1), ...modules(join(sub, 'code'), 1)]),
    );
    expect(errors.mock.calls.map((c) => String(c[0]).slice(0, 42))).toEqual([
      "⚠ Your project's @sensigo/realm is 9.9.9 (",
      "⚠ Your project's @sensigo/realm is 8.8.8 (",
    ]);
  });

  it('a copy nested under another package names that package as the installer', async () => {
    const nested = join(root, 'node_modules', '@sensigo', 'realm-cli');
    const copy = fakeRealm(nested, '9.9.9');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadProjectExtensions(definition('nested', modules(join(nested, 'dist'), 1)));
    expect(errors.mock.calls).toEqual([[advisoryFor('9.9.9', copy, '@sensigo/realm-cli')]]);
  });

  it('the same version as the engine, and a module with no realm above it, print nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadProjectExtensions(definition('none', modules(join(root, 'code'), 1)));
    fakeRealm(root, ENGINE_VERSION);
    clearProjectExtensionsCache();
    await loadProjectExtensions(definition('same', modules(join(root, 'code2'), 1)));
    expect(errors).not.toHaveBeenCalled();
  });

  it('makeRegistryProvider (realm mcp, realm serve) uses the default sink: stderr once, stdout nothing', async () => {
    fakeRealm(root, '9.9.9');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = makeRegistryProvider();
    const def = definition('mcp', modules(join(root, 'code'), 1));
    await provider(def);
    await provider(def);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('the result and the collecting sink', () => {
  it('releaseLineWarnings carries the facts as data; the collecting sink prints nothing', async () => {
    const copy = fakeRealm(root, '9.9.9');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadProjectExtensions(
      definition('collect', modules(join(root, 'code'), 2)),
      {
        onReleaseLineWarning: collectReleaseLineWarnings,
      },
    );
    expect(errors).not.toHaveBeenCalled();
    expect(loaded.releaseLineWarnings).toHaveLength(1);
    const w = loaded.releaseLineWarnings![0]!;
    expect(w.code).toBe('REALM_RELEASE_LINE_MISMATCH');
    expect(w.severity).toBe('warn');
    expect(w.scope).toBe('workflow');
    expect(w.message.startsWith('⚠')).toBe(false);
    expect(w.release_line).toEqual({
      project: { version: '9.9.9', path: copy, installed_by: 'project' },
      engine: { version: ENGINE_VERSION, path: ENGINE_PATH },
    });
  });
});

describe('realm listen', () => {
  it('tells its logger once per distinct copy at startup, however many workflows share it', async () => {
    fakeRealm(root, '9.9.9');
    const warns: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    const routes = new Map(
      ['a', 'b'].map((id) => [
        `/${id}`,
        {
          path: `/${id}`,
          definition: definition(`listen-${id}`, modules(join(root, `code-${id}`), 1)),
          trigger: { type: 'webhook', path: `/${id}`, auth: { mode: 'none' } },
          workflowDir: root,
        },
      ]),
    ) as never;
    await prepareListenWorkflows(routes, {
      workflowStore: { register: async () => {}, get: async () => undefined as never },
      logger,
    });
    expect(warns.filter((w) => w.includes("Your project's @sensigo/realm"))).toHaveLength(1);
  });
});

describe('realm workflow watch', () => {
  it('prints the advisory in the pass’s warning block and keeps registering (policy warn)', async () => {
    fakeRealm(root, '9.9.9');
    const [mod] = modules(join(root, 'code'), 1);
    const wfDir = join(root, 'workflows', 'watched');
    mkdirSync(wfDir, { recursive: true });
    const file = join(wfDir, 'workflow.yaml');
    writeFileSync(
      file,
      [
        'id: watched',
        'name: Watched',
        'version: 1',
        `extensions: ../../code/${mod!.split('/').pop()}`,
        'steps:',
        '  s1:',
        '    description: step',
        '    execution: agent',
        '',
      ].join('\n'),
    );
    const registered: unknown[] = [];
    const store = {
      register: async (d: unknown) => {
        registered.push(d);
      },
      get: async () => undefined as never,
      list: async () => [],
    };
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const { watchWorkflow } = await import('../commands/watch.js');
    const watching = watchWorkflow(file, store as never, controller.signal);
    for (let i = 0; i < 200 && registered.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await watching.catch(() => undefined);
    expect(registered).toHaveLength(1);
    const advisories = warns.mock.calls.filter((c) =>
      String(c[0]).includes("Your project's @sensigo/realm is 9.9.9"),
    );
    expect(advisories).toHaveLength(1);
  });
});
