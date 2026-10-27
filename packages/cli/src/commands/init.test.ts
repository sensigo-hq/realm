// Tests for initWorkflow business logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initWorkflow } from './init.js';
import { findTrustRoot, loadWorkflowFromString } from '@sensigo/realm';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'realm-init-test-'));
});

describe('initWorkflow', () => {
  it('creates all four files with correct name substitution', async () => {
    const target = join(baseDir, 'my-workflow');
    await initWorkflow('my-workflow', target);

    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    const schema = await readFile(join(target, 'schema.json'), 'utf8');
    const envEx = await readFile(join(target, '.env.example'), 'utf8');
    const readme = await readFile(join(target, 'README.md'), 'utf8');

    expect(yaml).toContain('id: my-workflow');
    expect(yaml).toContain('name: "my-workflow"');
    expect(schema).toContain('"$schema"');
    expect(envEx).toContain('EXAMPLE_API_KEY');
    expect(readme).toContain('# my-workflow');
    expect(readme).toContain('realm workflow validate');
  });

  it('throws an error when target directory already exists', async () => {
    const target = join(baseDir, 'existing-dir');
    await mkdir(target);
    await expect(initWorkflow('existing-dir', target)).rejects.toThrow('Directory already exists');
  });

  it('generated workflow.yaml passes loadWorkflowFromString without errors', async () => {
    const target = join(baseDir, 'valid-workflow');
    await initWorkflow('valid-workflow', target);
    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    const def = loadWorkflowFromString(yaml);
    expect(def.id).toBe('valid-workflow');
    expect(def.steps).toHaveProperty('step_one');
    expect(def.steps).toHaveProperty('step_two');
  });

  it('scaffolds a commented extensions line and a registry.sample.js (nothing active by default)', async () => {
    const target = join(baseDir, 'ext-workflow');
    await initWorkflow('ext-workflow', target);

    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    expect(yaml).toContain('# extensions: ./registry.js');
    expect(yaml).toContain('docs/reference/project-extensions.md');
    // Commented out — the loader must see no extensions key.
    expect(loadWorkflowFromString(yaml).extensions).toBeUndefined();

    const sample = await readFile(join(target, 'registry.sample.js'), 'utf8');
    expect(sample).toContain('export default {');
    expect(sample).toContain('// adapters: {');
    expect(sample).toContain('// handlers: {');
    expect(sample).toContain('// processors: {');
    expect(sample).toContain('docs/reference/project-extensions.md');
    // The sample is valid JS whose default export declares nothing.
    const dataUrl = `data:text/javascript;base64,${Buffer.from(sample).toString('base64')}`;
    const mod = (await import(dataUrl)) as { default: Record<string, unknown> };
    expect(mod.default).toEqual({});
  });
});

// #878: inside a project — a folder above the new one holds a package.json or a .git — Realm reads
// realm.yaml only from the project's top folder (core's findTrustRoot), so init writes four files
// and names that folder. Every value printed on failure is a file name, an exit code or the
// command's stdout with the scratch folders replaced by <base> and <home>; never an environment.
describe('inside a project (#878)', { timeout: 60_000 }, () => {
  const SIX = [
    'workflow.yaml',
    'schema.json',
    '.env.example',
    'README.md',
    'registry.sample.js',
    'realm.yaml',
  ];
  const FOUR = ['workflow.yaml', 'schema.json', 'README.md', 'registry.sample.js'];
  /** The built `realm` (`packages/cli/package.json` `bin.realm`). */
  const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

  const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const newBase = (): string => scratch('realm-init-878-');
  const newHome = (): string => scratch('realm-878-home-');
  /** Cell 4's guard: the cells below assume the machine's temp folder lies outside any project. */
  const ownProject = (base: string): void => {
    const root = findTrustRoot(base);
    // (a) red when a folder above the temp folder holds a package.json or a .git; (b) prints the
    //     folder findTrustRoot returned — this cell cannot run on such a machine.
    expect(root, `the temp folder lies inside the project '${root}'`).toBe(base);
  };
  /** One run of the built `realm` in `cwd`, its output piped (the log audience). */
  const realm = (args: string[], cwd: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const env = (home: string): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    NO_COLOR: '1',
    // A piped run is a log, where paths under HOME are hidden; the cells read the operator's
    // terminal text, so HOME is named not secret (as docs-examples-625 does). Cell 5 (iv) leaves
    // this out on purpose.
    REALM_NOT_SECRET: 'HOME',
  });
  const scrub = (text: string, base: string, home: string): string =>
    text.split(base).join('<base>').split(home).join('<home>');
  const NEXT = 'Next: realm workflow validate ./invoice-check/';
  const PROJECT_LINES = (root: string, last: string): string[] => [
    `invoice-check/ is inside the project '${root}', which holds a package.json or a .git.`,
    'Realm reads realm.yaml only from that folder, so it and .env.example were not written here.',
    last,
  ];
  const NO_MANIFEST =
    'The project has no realm.yaml yet: add one there when a workflow needs settings — how an adapter, handler or processor is built, its secrets, or a gate notifier.';
  const HAS_MANIFEST = "The project's realm.yaml applies to this workflow.";
  const stdoutOf = (files: readonly string[], projectLines: string[] = []): string =>
    [
      'Created: invoice-check/',
      ...files.map((f) => `  ${f}`),
      '',
      ...(projectLines.length > 0 ? [...projectLines, ''] : []),
      NEXT,
      '',
    ].join('\n');

  it('1: under a package.json — four files, the project named, no realm.yaml there', async () => {
    const base = newBase();
    writeFileSync(join(base, 'package.json'), '{}');
    const result = await initWorkflow('wf', join(base, 'wf'));
    // (a) red when init ignores the package.json above it (six files, no project) or before #878
    //     (it returned nothing); (b) prints the result with <base> for the folder.
    expect(JSON.parse(scrub(JSON.stringify(result ?? null), base, '\0'))).toEqual({
      files: FOUR,
      project: { root: '<base>', hasManifest: false },
    });
    // (a) red when realm.yaml or .env.example is written into the new folder; (b) prints the names.
    expect(readdirSync(join(base, 'wf')).sort()).toEqual([...FOUR].sort());
  });

  it('2: under a .git — the same', async () => {
    const base = newBase();
    mkdirSync(join(base, '.git'));
    const result = await initWorkflow('wf', join(base, 'wf'));
    // (a) red when init ignores the .git above it; (b) prints the result with <base>.
    expect(JSON.parse(scrub(JSON.stringify(result ?? null), base, '\0'))).toEqual({
      files: FOUR,
      project: { root: '<base>', hasManifest: false },
    });
    // (a) red when realm.yaml or .env.example is written; (b) prints the names.
    expect(readdirSync(join(base, 'wf')).sort()).toEqual([...FOUR].sort());
  });

  it('3: the project already has a realm.yaml — it is read, never touched', async () => {
    const base = newBase();
    writeFileSync(join(base, 'package.json'), '{}');
    const manifest = '# the project manifest\n';
    writeFileSync(join(base, 'realm.yaml'), manifest);
    const result = await initWorkflow('wf', join(base, 'wf'));
    // (a) red when hasManifest does not read the project's realm.yaml; (b) prints the result.
    expect(JSON.parse(scrub(JSON.stringify(result ?? null), base, '\0'))).toEqual({
      files: FOUR,
      project: { root: '<base>', hasManifest: true },
    });
    // (a) red when init changes the project's realm.yaml; (b) prints its text.
    expect(readFileSync(join(base, 'realm.yaml'), 'utf8')).toBe(manifest);
    // (a) red when init writes anything beside it at the project's top folder; (b) prints the names.
    expect(readdirSync(base).sort()).toEqual(['package.json', 'realm.yaml', 'wf']);
  });

  it('4: control — the folder is its own project: six files, as before', async () => {
    const base = newBase();
    ownProject(base);
    const result = await initWorkflow('wf', join(base, 'wf'));
    // (a) red when a folder that is its own project loses a file or the order changes; (b) prints
    //     the result (no folder in it).
    expect(result).toEqual({ files: SIX });
    // (a) red when realm.yaml's template changes; (b) prints its first line.
    expect(readFileSync(join(base, 'wf', 'realm.yaml'), 'utf8').split('\n')[0]).toBe(
      '# realm.yaml — deployment manifest for this project (see docs/reference/deployment-manifest.md).',
    );
  });

  it('5 (i): what init prints in a folder that is its own project — today’s nine lines', () => {
    const base = newBase();
    const home = newHome();
    ownProject(base);
    const r = realm(['workflow', 'init', 'invoice-check'], base, env(home));
    // (a) red when the plain case's lines change; (b) prints the exit code and stdout (<base>, <home>).
    expect({ status: r.status, stdout: scrub(r.stdout, base, home) }).toEqual({
      status: 0,
      stdout: stdoutOf(SIX),
    });
  });

  it('5 (ii): inside a project with a package.json and no realm.yaml', () => {
    const base = newBase();
    const home = newHome();
    writeFileSync(join(base, 'package.json'), '{}');
    const r = realm(['workflow', 'init', 'invoice-check'], base, env(home));
    // (a) red when the four files, the project lines or the "no realm.yaml yet" line change;
    //     (b) prints the exit code and stdout (<base>, <home>).
    expect({ status: r.status, stdout: scrub(r.stdout, base, home) }).toEqual({
      status: 0,
      stdout: stdoutOf(FOUR, PROJECT_LINES('<base>', NO_MANIFEST)),
    });
  });

  it('5 (iii): inside a project with a .git and a realm.yaml', () => {
    const base = newBase();
    const home = newHome();
    mkdirSync(join(base, '.git'));
    writeFileSync(join(base, 'realm.yaml'), '# the project manifest\n');
    const r = realm(['workflow', 'init', 'invoice-check'], base, env(home));
    // (a) red when the "applies to this workflow" line is not printed for a project that has a
    //     realm.yaml; (b) prints the exit code and stdout (<base>, <home>).
    expect({ status: r.status, stdout: scrub(r.stdout, base, home) }).toEqual({
      status: 0,
      stdout: stdoutOf(FOUR, PROJECT_LINES('<base>', HAS_MANIFEST)),
    });
  });

  it("5 (iv): the project's path prints whole in a log under HOME", () => {
    const home = newHome();
    const shop = join(home, 'shop');
    mkdirSync(shop);
    writeFileSync(join(shop, 'package.json'), '{}');
    const r = realm(['workflow', 'init', 'invoice-check'], shop, {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      NO_COLOR: '1',
    });
    // (a) red when the project's folder is printed as plain text (the log hides HOME's part:
    //     '[REDACTED]/shop'); (b) prints the exit code and stdout (<home>).
    expect({ status: r.status, stdout: scrub(r.stdout, '\0', home) }).toEqual({
      status: 0,
      stdout: stdoutOf(FOUR, PROJECT_LINES('<home>/shop', NO_MANIFEST)),
    });
  });

  it('6: the acceptance — inside a project, init then validate passes', () => {
    for (const marker of ['package.json', '.git'] as const) {
      const base = newBase();
      const home = newHome();
      if (marker === '.git') mkdirSync(join(base, '.git'));
      else writeFileSync(join(base, 'package.json'), '{}');
      const init = realm(['workflow', 'init', 'wf'], base, env(home));
      const validate = realm(['workflow', 'validate', './wf/'], base, env(home));
      // (a) red when init writes a realm.yaml the loader refuses (validate exits 1, "will NOT be
      //     loaded"); (b) prints the marker, both exit codes and validate's first stdout line and
      //     stderr (<base>, <home>).
      expect({
        marker,
        init: init.status,
        validate: validate.status,
        first: scrub(validate.stdout, base, home).split('\n')[0],
        stderr: scrub(validate.stderr, base, home),
      }).toMatchObject({
        marker,
        init: 0,
        validate: 0,
        first: expect.stringMatching(/^Valid: wf v1/),
      });
    }
  });

  it('7: the pages say what the command does', () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const page = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
    /** Whitespace collapsed: a sentence the page wraps across lines still reads word for word. */
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    /** The first ```text block after `marker` on the page. */
    const blockAfter = (text: string, marker: string): string => {
      const at = text.indexOf(marker);
      const open = text.indexOf('```text\n', at === -1 ? text.length : at);
      return at === -1 || open === -1
        ? `<no block after ${marker}>`
        : text.slice(open + 8, text.indexOf('\n```', open + 8));
    };
    const WF = page('docs/reference/cli/realm-workflow.md');
    const sentences: Array<[string, string]> = [
      [
        'docs/reference/cli/realm-workflow.md',
        "Creates a folder called `<name>` with six files. Inside a project — when a folder above it holds a `package.json` or a `.git` — it writes four: Realm reads `realm.yaml` only from the project's top folder ([Deployment manifest](../deployment-manifest.md#where-realm-looks-for-it)), so `init` leaves `realm.yaml` and `.env.example` out of the new folder and names the project's folder.",
      ],
      [
        'docs/reference/environment-and-files.md',
        'A folder `<name>` with `workflow.yaml`, `schema.json`, `.env.example`, `README.md`, `registry.sample.js` and `realm.yaml`; inside a project, without `.env.example` and `realm.yaml`.',
      ],
      [
        'README.md',
        "Inside an existing project (a folder above it holds a `package.json` or a `.git`) it leaves out `realm.yaml` and `.env.example`, which belong in the project's top folder.",
      ],
      [
        'docs/start/install-and-first-run.md',
        "Inside an existing project — a folder above it holds a `package.json` or a `.git` — it creates four files, leaves out `realm.yaml` and `.env.example`, and names the project's top folder, where Realm reads `realm.yaml`.",
      ],
      [
        'CHANGELOG.md',
        "- **`realm workflow init` inside a project no longer writes a `realm.yaml` Realm refuses (issue #878).** When a folder above the new one holds a `package.json` or a `.git` — a local install, any git repository — it writes four files, leaving out `realm.yaml` and `.env.example`, and names the project's top folder, where Realm reads `realm.yaml`. Before, the first `realm workflow validate` there failed.",
      ],
    ];
    // (a) red when a page's sentence about init's files parts from the agreed words; (b) prints the
    //     page and whether each sentence is there.
    expect(sentences.map(([rel, s]) => [rel, flat(page(rel)).includes(flat(s))])).toEqual(
      sentences.map(([rel]) => [rel, true]),
    );

    const printed = (setup: (base: string) => void): string => {
      const base = newBase();
      const home = newHome();
      setup(base);
      const r = realm(['workflow', 'init', 'invoice-check'], base, env(home));
      return scrub(r.stdout, base, home).replace(/\n$/, '');
    };
    const plain = printed((base) => ownProject(base));
    const inProject = printed((base) => writeFileSync(join(base, 'package.json'), '{}'));
    const withManifest = printed((base) => {
      mkdirSync(join(base, '.git'));
      writeFileSync(join(base, 'realm.yaml'), '# the project manifest\n');
    });
    const lastOf = (text: string, marker: string): string => {
      const at = text.indexOf(marker);
      return at === -1 ? `<no "${marker}">` : (text.slice(at + marker.length).split('`')[1] ?? '');
    };
    // (a) red when a block on the page parts from what `realm workflow init invoice-check` prints
    //     (the plain case, inside a project at /srv/shop, and the line for a project with a
    //     realm.yaml); (b) prints both texts of each.
    expect({
      sixFiles: blockAfter(WF, '```bash\nrealm workflow init invoice-check\n```'),
      insideProject: blockAfter(
        WF,
        'Inside the project `/srv/shop`, which holds a `package.json`:',
      ),
      lastLine: lastOf(WF, 'the last of those lines reads '),
    }).toEqual({
      sixFiles: plain,
      insideProject: inProject.split('<base>').join('/srv/shop'),
      lastLine: withManifest.split('\n').find((l) => l.startsWith('The project')),
    });
  });
});
