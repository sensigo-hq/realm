// #729 PR-3 (03 L-4; 04 "Records"; RECORD 01 #7, #17): the read commands' manifest read, export v5
// per declared state, inspect's receipt line, and abandon's rerun. Every value is fake. Each
// assertion names (a) the change that turns it red and (b) what it prints: states, causes, counts,
// booleans and fake text — never a value from outside this file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  abandonRun,
  buildDisclosureSet,
  executeChain,
  executeStep,
  type DisclosureReceipt,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { readRunManifest } from '../lib/read-run-manifest.js';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { cliDisclosureProvider, installWriter, writerTestSeams } from '../output/writer.js';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildExportBundle, exportDisclosureLine, exportDisclosureRefusal } from './export.js';
import { inspectReceiptLine, type InspectSurfaceReceipt } from './inspect.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const SECRET = 'FAKE-RECORD-SECRET-0729';
const ENV_CANARY = 'fake-env-canary-0729';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-records-729-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function definitionAt(
  trustRoot: string | undefined,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: 'records-729',
    name: 'records',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
    ...(trustRoot !== undefined ? { trust_root: trustRoot } : {}),
    ...extra,
  } as WorkflowDefinition;
}

function manifest(dir: string, yaml: string, env = ''): void {
  writeFileSync(join(dir, 'realm.yaml'), yaml, 'utf8');
  writeFileSync(join(dir, '.env'), env, 'utf8');
}

const MANIFEST =
  'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\ndisclosure:\n  not_secret: [APP_REGION]\n';

describe('#729 PR-3 — readRunManifest: the declared state and its cause, per producing branch', () => {
  it('each branch', async () => {
    const withManifest = join(root, 'with');
    mkdirSync(withManifest);
    manifest(withManifest, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    const bare = join(root, 'bare');
    mkdirSync(bare);
    const invalid = join(root, 'invalid');
    mkdirSync(invalid);
    manifest(invalid, 'version: 1\nnot_a_key: true\n');
    const unresolved = join(root, 'unresolved');
    mkdirSync(unresolved);
    manifest(unresolved, MANIFEST, '');
    const recorded = (path: string, hash: string, secretNames: string[] = []): RunRecord =>
      ({
        extension_identity: [{ manifest: { path, content_hash: hash }, secret_names: secretNames }],
      }) as unknown as RunRecord;
    const state = async (d: WorkflowDefinition | undefined, run?: RunRecord) => {
      const m = await readRunManifest(d, run, {});
      return [
        m.declaredState,
        m.declaredCause ?? null,
        Object.keys(m.declared).length,
        m.notSecret ?? null,
      ];
    };
    // (a) red when a branch reports another state or cause, loses the declared values or the
    //     not-secret list, trusts a manifest that dropped a recorded secret, or distrusts one
    //     whose other parts changed (D-12), or (H-7) a run whose copy cannot be read does not read
    //     the manifest its record names; (b) prints each branch's tuple.
    expect({
      noDefinition: await state(undefined),
      noDefinitionRecorded: await state(
        undefined,
        recorded(join(withManifest, 'realm.yaml'), 'not-its-hash', ['SVC_TOKEN']),
      ),
      noDefinitionRecordedGone: await state(
        undefined,
        recorded(join(root, 'gone', 'realm.yaml'), 'x'),
      ),
      noProject: await state(definitionAt(undefined)),
      rootWithoutManifest: await state(definitionAt(bare)),
      resolved: await state(definitionAt(withManifest)),
      recordedGone: await state(
        definitionAt(withManifest),
        recorded(join(root, 'gone', 'realm.yaml'), 'x'),
      ),
      recordedSecretGone: await state(
        definitionAt(withManifest),
        recorded(join(withManifest, 'realm.yaml'), 'not-its-hash', ['SVC_TOKEN', 'OLD_TOKEN']),
      ),
      recordedOtherEdit: await state(
        definitionAt(withManifest),
        recorded(join(withManifest, 'realm.yaml'), 'not-its-hash', ['SVC_TOKEN']),
      ),
      invalid: await state(definitionAt(invalid)),
      unresolvable: await state(definitionAt(unresolved)),
    }).toEqual({
      noDefinition: ['unknown', 'load_failed', 0, null],
      noDefinitionRecorded: ['resolved', null, 1, ['APP_REGION']],
      noDefinitionRecordedGone: ['partial', 'manifest_changed', 0, null],
      noProject: ['unknown', 'no_manifest', 0, null],
      rootWithoutManifest: ['resolved', null, 0, null],
      resolved: ['resolved', null, 1, ['APP_REGION']],
      recordedGone: ['partial', 'manifest_changed', 0, null],
      recordedSecretGone: ['partial', 'manifest_changed', 1, ['APP_REGION']],
      recordedOtherEdit: ['resolved', null, 1, ['APP_REGION']],
      invalid: ['unknown', 'load_failed', 0, null],
      unresolvable: ['unknown', 'load_failed', 0, null],
    });
  });

  it("the webhook trigger's secret is declared (D3/08 m9)", async () => {
    const d = definitionAt(undefined, {
      trigger: { auth: { mode: 'github', secret_from: 'HOOK_SECRET' } },
    } as Partial<WorkflowDefinition>);
    const m = await readRunManifest(d, undefined, { HOOK_SECRET: SECRET });
    // (a) red when the webhook's secret is left to the environment sweep; (b) prints the names.
    expect(Object.keys(m.declared)).toEqual(['webhook:HOOK_SECRET']);
  });
});

describe('#729 PR-3 — export v5', () => {
  it('refuses unless every declared secret is known; the refusal names the state, never a value', () => {
    const refusal = (declaredState: 'resolved' | 'partial' | 'unknown', declaredCause?: string) =>
      exportDisclosureRefusal('r1', {
        declaredState,
        ...(declaredCause !== undefined ? { declaredCause: declaredCause as never } : {}),
        declared: { S: SECRET },
      });
    const r = {
      resolved: refusal('resolved'),
      noProject: refusal('unknown', 'no_manifest'),
      loadFailed: refusal('unknown', 'load_failed'),
      changed: refusal('partial', 'manifest_changed'),
    };
    // (a) red when a not-resolved state is exported silently, or a resolved one refused; (b)
    //     prints which refused and whether a value leaked.
    expect({
      resolved: r.resolved === undefined,
      noProject: r.noProject?.includes('has no project') === true,
      loadFailed: r.loadFailed?.includes('could not be read') === true,
      changed: r.changed?.includes('changed since the run recorded it') === true,
      flagNamed: r.changed?.includes('--accept-partial-disclosure') === true,
      // F33: a run with no project has no manifest to restore; the others are told to restore it.
      noProjectRemedy: [
        r.noProject?.includes('The run has no manifest to restore') === true,
        r.noProject?.includes('Restore the manifest') === true,
        r.noProject?.includes('--accept-partial-disclosure') === true,
      ],
      othersRestore: [r.loadFailed, r.changed].every(
        (t) => t?.includes('Restore the manifest the run used') === true,
      ),
      leaked: Object.values(r).some((t) => t?.includes(SECRET) === true),
    }).toEqual({
      resolved: true,
      noProject: true,
      loadFailed: true,
      changed: true,
      flagNamed: true,
      noProjectRemedy: [true, false, true],
      othersRestore: true,
      leaked: false,
    });
  });

  it('F26: the export walks the bundle with its marks removed first, and the file holds none', async () => {
    const store = new JsonFileStore(join(root, 'runs'));
    const { run } = await store.create({
      workflowId: 'records-729',
      workflowVersion: 1,
      params: { note: `x ${ENV_CANARY.slice(0, 5)}\uE001${ENV_CANARY.slice(5)}` },
    });
    const set = buildDisclosureSet({
      env: { APP_CANARY: ENV_CANARY },
      declared: {},
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      set,
    );
    const file = JSON.stringify(bundle);
    // (a) red when the walk reads the value with the mark inside it (the mark parts the value, so
    //     the law misses it) or a mark reaches the file; (b) prints the shown param and a boolean.
    expect({ note: bundle.run.params['note'], marks: /[\uE000-\uE002]/.test(file) }).toEqual({
      note: 'x [REDACTED]',
      marks: false,
    });
  });

  it('the masked line counts the declared values too short to hide, and says a question was masked at the declared tier only (F14, F16)', async () => {
    const store = new JsonFileStore(join(root, 'runs'));
    const { run } = await store.create({
      workflowId: 'records-729',
      workflowVersion: 1,
      params: { key: SECRET },
    });
    const set = buildDisclosureSet({
      env: {},
      declared: { S: SECRET, PIN: 'ab1' },
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      set,
    );
    // (a) red when the too-short count is dropped (F14) or the question clause is lost (F16);
    //     (b) prints both header lines (counts and fixed words only).
    expect([
      exportDisclosureLine(bundle.disclosure),
      exportDisclosureLine({ ...bundle.disclosure, question: 'declared_only' }),
    ]).toEqual([
      'masked: declared secrets resolved; environment swept; hidden 1 declared, 0 environment, 0 by pattern; 1 too short to hide',
      'masked: declared secrets resolved; environment swept; hidden 1 declared, 0 environment, 0 by pattern; 1 too short to hide; question: declared tier only',
    ]);
  });

  it('the bundle is version 5, masked by the file audience, carries its receipt; the record stays raw', async () => {
    const runs = join(root, 'runs');
    const store = new JsonFileStore(runs);
    const { run } = await store.create({
      workflowId: 'records-729',
      workflowVersion: 1,
      params: { key: SECRET, note: 'ordinary' },
    });
    const set = buildDisclosureSet({
      env: {},
      declared: { S: SECRET },
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      set,
    );
    // (a) red when the bundle is not walked, the receipt is missing, or the record is written
    //     into; (b) prints the version, the shown params and the receipt's counts.
    expect({
      version: bundle.realm_export_version,
      params: bundle.run.params,
      receipt: [bundle.disclosure.declared, bundle.disclosure.hidden.declared],
      storeRaw: (await store.get(run.id)).params['key'] === SECRET,
    }).toEqual({
      version: 5,
      params: { key: '[REDACTED]', note: 'ordinary' },
      receipt: ['resolved', 1],
      storeRaw: true,
    });
  });

  it('the command: refused without --accept-partial-disclosure; with it, written and its header names the state', async () => {
    const home = join(root, 'home');
    const runs = join(home, '.realm', 'runs');
    mkdirSync(runs, { recursive: true });
    // A run whose workflow copy cannot be read: the declared secrets are unknown (load_failed).
    const { run } = await new JsonFileStore(runs).create({
      workflowId: 'not-registered',
      workflowVersion: 1,
      params: {},
    });
    const realm = (...args: string[]) =>
      spawnSync(process.execPath, [CLI_ENTRY, 'run', 'export', run.id, ...args], {
        cwd: root,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NOT_SECRET: 'HOME' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const refused = realm('--out', join(root, 'a.json'));
    const accepted = realm('--out', join(root, 'b.json'), '--accept-partial-disclosure');
    const bundle = existsSync(join(root, 'b.json'))
      ? (JSON.parse(readFileSync(join(root, 'b.json'), 'utf8')) as {
          disclosure: DisclosureReceipt;
        })
      : undefined;
    // (a) red when the refusal is dropped, the flag is ignored, or the header and bundle do not
    //     name the state; (b) prints exit codes, booleans and the bundle's state.
    expect({
      refusedCode: refused.status,
      refusedWritten: existsSync(join(root, 'a.json')),
      acceptedCode: accepted.status,
      header: accepted.stdout.includes('masked: declared secrets unknown (load failed)'),
      state: bundle?.disclosure.declared,
    }).toEqual({
      refusedCode: 1,
      refusedWritten: false,
      acceptedCode: 0,
      header: true,
      state: 'unknown',
    });
  }, 60_000);
});

describe('#729 PR-3 — inspect prints one receipt line', () => {
  it('names on a terminal, kinds and counts otherwise', () => {
    const receipt: InspectSurfaceReceipt = {
      declared: 'resolved',
      terminal: false,
      hidden: { declared: 1, environment: 2, pattern: 0 },
      unchecked: 0,
      unmaskable: 0,
      members: ['declared:API_TOKEN', 'env:HOME'],
      question: false,
    };
    // (a) red when a log line names a source, a terminal line drops them or says "environment
    //     swept", or the question clause is lost (F13, F16); (b) prints the three lines.
    expect([
      inspectReceiptLine(receipt),
      inspectReceiptLine({
        ...receipt,
        terminal: true,
        hidden: { declared: 1, environment: 0, pattern: 0 },
        members: ['declared:API_TOKEN'],
      }),
      inspectReceiptLine({ ...receipt, question: true }),
    ]).toEqual([
      'Disclosure: declared values resolved; environment swept; hidden 1 declared, 2 environment, 0 by pattern; 0 not checked; 0 too short to hide.',
      "Disclosure: declared values resolved; environment values and values after a credential's name are shown on this terminal; hidden 1 declared: declared:API_TOKEN; 0 not checked; 0 too short to hide.",
      'Disclosure: declared values resolved; environment swept; hidden 1 declared, 2 environment, 0 by pattern; 0 not checked; 0 too short to hide; question: declared tier only.',
    ]);
  });

  /** A run whose params hold the declared value (inspect does not show them) and whose one step's
   *  output holds it and an environment canary (inspect shows that). */
  async function shownAndUnshown(): Promise<{ home: string; runId: string }> {
    const home = join(root, 'home');
    const runs = join(home, '.realm', 'runs');
    mkdirSync(runs, { recursive: true });
    const project = join(root, 'project');
    mkdirSync(project);
    manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definitionAt(project));
    const store = new JsonFileStore(runs);
    const { run } = await store.create({
      workflowId: 'records-729',
      workflowVersion: 1,
      params: { key: SECRET },
    });
    await store.update({
      ...run,
      completed_steps: ['a'],
      evidence: [
        {
          step_id: 'a',
          started_at: '2024-01-01T00:00:00.000Z',
          completed_at: '2024-01-01T00:00:01.000Z',
          duration_ms: 1000,
          input_summary: {},
          output_summary: { note: SECRET, region: ENV_CANARY },
          status: 'success',
          evidence_hash: 'abc123def456789012345678901234567890abcd',
        },
      ],
    });
    return { home, runId: run.id };
  }

  it("the command prints it after the record, from the run's manifest read, counting what it showed", async () => {
    const { home, runId } = await shownAndUnshown();
    const r = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', runId], {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        REALM_NOT_SECRET: 'HOME',
        APP_CANARY: ENV_CANARY,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    // (a) red when the receipt line is missing, a value shows, or it counts the record walk (the
    //     params' copy too: 2 declared) instead of what it showed (F13); (b) prints the exit code,
    //     the last line and two booleans.
    expect({
      code: r.status,
      last,
      leaked: r.stdout.includes(SECRET),
      canaryShown: r.stdout.includes(ENV_CANARY),
    }).toEqual({
      code: 0,
      last: 'Disclosure: declared values resolved; environment swept; hidden 1 declared, 1 environment, 0 by pattern; 0 not checked; 0 too short to hide.',
      leaked: false,
      canaryShown: false,
    });
  }, 60_000);

  it('on a terminal it says environment values are shown there, and counts what it showed (F13)', async () => {
    const { home, runId } = await shownAndUnshown();
    const q = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, CLI_ENTRY, 'run', 'inspect', runId];
    const argv =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', ...command]
        : ['-qec', command.map(q).join(' '), '/dev/null'];
    const r = spawnSync('script', argv, {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        REALM_NOT_SECRET: 'HOME',
        APP_CANARY: ENV_CANARY,
        NO_COLOR: '1',
        SHELL: '/bin/sh',
      },
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = r.stdout.replaceAll('\r', '');
    const last = out.trim().split('\n').at(-1) ?? '';
    // (a) red when the terminal line says "environment swept", counts the record walk (2
    //     declared), drops the source's name, or the declared value shows; (b) prints the exit code,
    //     the last line and two booleans (the canary is this file's own fake value).
    expect({
      code: r.status,
      last,
      leaked: out.includes(SECRET),
      canaryShown: out.includes(ENV_CANARY),
    }).toEqual({
      code: 0,
      last: "Disclosure: declared values resolved; environment values and values after a credential's name are shown on this terminal; hidden 1 declared: declared:SVC_TOKEN; 0 not checked; 0 too short to hide.",
      leaked: false,
      canaryShown: true,
    });
  }, 60_000);
});

describe('#729 PR-3 correction 1 (F28) — inspect shows a guard abort', () => {
  it("each condition, whether it passed and its value at the surface's tier, and the run's aborted_at", async () => {
    const home = join(root, 'home');
    const runs = join(home, '.realm', 'runs');
    mkdirSync(runs, { recursive: true });
    const def = {
      ...definitionAt(undefined),
      id: 'guard-729',
      steps: {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        check: {
          description: 'Check.',
          execution: 'guard',
          depends_on: ['a'],
          abort_unless: ["a.status == 'open'", 'a.count > 1'],
          abort_message: 'The ticket is not open.',
        },
      },
    } as WorkflowDefinition;
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
    const store = new JsonFileStore(runs);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // The engine writes the record: a real guard abort, its conditions and its marker.
    await executeChain(store, def, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({ status: ENV_CANARY, count: 3 }),
    });
    const r = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', run.id], {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        REALM_NOT_SECRET: 'HOME',
        APP_CANARY: ENV_CANARY,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const lines = r.stdout.split('\n');
    // (a) red when the guard's conditions or the aborted_at line are not rendered, or a condition's
    //     value shows on a log; (b) prints the exit code, the two lines and a boolean (the canary is
    //     this file's own fake value).
    expect({
      code: r.status,
      abortedAt: lines.find((l) => l.startsWith('Aborted at:')),
      guard: lines.find((l) => l.includes('| guard: '))?.replace(/^.*\| guard: /, ''),
      canaryShown: r.stdout.includes(ENV_CANARY),
    }).toEqual({
      code: 0,
      abortedAt: `Aborted at: 'check': "The ticket is not open."`,
      guard: `a.status == 'open' → failed ("[REDACTED]"), a.count > 1 → passed (3)`,
      canaryShown: false,
    });
  }, 60_000);
});

describe("#729 PR-3 correction 1 (F29, D-12) — which edits to realm.yaml change a run's declared values", () => {
  const state = async (dir: string, run: RunRecord) => {
    const m = await readRunManifest(definitionAt(dir), run, {});
    return [m.declaredState, m.declaredCause ?? null];
  };
  const write = (dir: string, yaml: string) => writeFileSync(join(dir, 'realm.yaml'), yaml, 'utf8');
  const ADAPTER =
    'adapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n';

  it('a run 0.47.1 recorded (names, no block hash): adding `disclosure:` keeps it; removing a secret it used changes it', async () => {
    const dir = join(root, 'old');
    mkdirSync(dir);
    const yaml = `version: 1\n${ADAPTER}`;
    manifest(dir, yaml, `SVC_TOKEN=${SECRET}\n`);
    // The entry as 0.47.1 writes it (its `types/extension-identity.ts`): the manifest's path and
    // raw-bytes sha256, and the secret names; no block hash.
    const run = {
      extension_identity: [
        {
          captured_at: '2026-10-17T00:00:00.000Z',
          modules: [],
          tree: { roots: [], tree_hash: 'fake-tree', file_count: 0 },
          coverage: 'dir_tree_v1',
          manifest: {
            path: join(dir, 'realm.yaml'),
            content_hash: createHash('sha256').update(yaml).digest('hex'),
          },
          secret_names: ['SVC_TOKEN'],
        },
      ],
    } as unknown as RunRecord;
    const unchanged = await state(dir, run);
    write(dir, `${yaml}disclosure:\n  not_secret: [APP_REGION]\n`);
    const disclosureAdded = await state(dir, run);
    write(dir, 'version: 1\ndisclosure:\n  not_secret: [APP_REGION]\n');
    const secretRemoved = await state(dir, run);
    // (a) red when the whole file's hash decides again (adding `disclosure:` would read partial),
    //     or a secret the run used may disappear unnoticed; (b) prints each state and cause.
    expect({ unchanged, disclosureAdded, secretRemoved }).toEqual({
      unchanged: ['resolved', null],
      disclosureAdded: ['resolved', null],
      secretRemoved: ['partial', 'manifest_changed'],
    });
  });

  it('a run this build recorded: a new handler with a new secret keeps it; a changed `secrets` block changes it', async () => {
    const dir = join(root, 'new');
    mkdirSync(dir);
    const secrets = (file: string) => `secrets:\n  sources: [dotenv]\n  dotenv: ${file}\n`;
    const yaml = `version: 1\n${secrets('.env')}${ADAPTER}`;
    manifest(dir, yaml, `SVC_TOKEN=${SECRET}\nNEW_TOKEN=FAKE-NEW-SECRET-0729\n`);
    writeFileSync(join(dir, '.env.other'), `SVC_TOKEN=${SECRET}\n`, 'utf8');
    const loaded = await loadProjectExtensions(definitionAt(dir));
    const entry = loaded.registry.identity;
    const run = { extension_identity: [entry] } as unknown as RunRecord;
    const recorded = await state(dir, run);
    write(dir, `${yaml}  more:\n    use: github\n    config: { token: "\${secret:NEW_TOKEN}" }\n`);
    const handlerAdded = await state(dir, run);
    write(dir, `version: 1\n${secrets('.env.other')}${ADAPTER}`);
    const blockChanged = await state(dir, run);
    // (a) red when names must be equal (a new secret would read partial), the block's hash is not
    //     compared (a new dotenv file would read resolved), or the build records no block hash;
    //     (b) prints whether the entry has the hash, and each state and cause.
    expect({
      hasBlockHash: typeof entry?.manifest?.secrets_block_hash === 'string',
      recorded,
      handlerAdded,
      blockChanged,
    }).toEqual({
      hasBlockHash: true,
      recorded: ['resolved', null],
      handlerAdded: ['resolved', null],
      blockChanged: ['partial', 'manifest_changed'],
    });
  });
});

describe('#729 PR-3 correction 1 (F37) — the short-secret warning says where the secret is used', () => {
  it('it names the manifest and the key that refers to the secret, and no longer says it shows everywhere', async () => {
    const dir = join(root, 'short');
    mkdirSync(dir);
    manifest(dir, MANIFEST, 'SVC_TOKEN=ab1\n');
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
    await loadProjectExtensions(definitionAt(dir));
    const warning = warned.find((w) => w.includes("Secret 'SVC_TOKEN'")) ?? '';
    // (a) red when the warning drops the manifest's path or the key, or says the old "it will show
    //     wherever it appears"; (b) prints booleans (the secret is a 3-character fake).
    expect({
      manifest: warning.includes(`(in ${join(dir, 'realm.yaml')}, at adapters.svc.config.token)`),
      oldWords: warning.includes('It will show wherever it appears'),
      value: warning.includes('ab1'),
    }).toEqual({ manifest: true, oldWords: false, value: false });
  });
});

describe("#729 PR-3 correction 1 (F11, D-11) — the CLI's provider reports each project's own standing", () => {
  it('a project whose manifest fails reads unknown, also after another loaded; a changed block reads partial; members stay the union', async () => {
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    manifest(good, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    // A manifest naming a secret its dotenv file does not hold: it cannot be resolved.
    manifest(bad, MANIFEST, '');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    installWriter('mcp');
    try {
      const standing = async (dir: string, run?: RunRecord) => {
        const set = await cliDisclosureProvider(definitionAt(dir), run);
        return [set.declared, set.declaredCause ?? null];
      };
      const goodFirst = await standing(good);
      const badAfter = await standing(bad);
      const changedRun = {
        extension_identity: [
          {
            manifest: {
              path: join(good, 'realm.yaml'),
              content_hash: 'fake',
              secrets_block_hash: 'not-this-block',
            },
            secret_names: ['SVC_TOKEN'],
          },
        ],
      } as unknown as RunRecord;
      const changed = await standing(good, changedRun);
      const badSet = await cliDisclosureProvider(definitionAt(bad));
      // (a) red when the provider ignores the workflow it is asked about (every project reads
      //     the same), a project's failure leaks into another's standing, or the members stop
      //     being the union; (b) prints each state and cause and a boolean.
      expect({
        goodFirst,
        badAfter,
        changed,
        unionHides: badSet.sources.includes('declared:SVC_TOKEN'),
      }).toEqual({
        goodFirst: ['resolved', null],
        badAfter: ['unknown', 'load_failed'],
        changed: ['partial', 'manifest_changed'],
        unionHides: true,
      });
    } finally {
      writerTestSeams.reset();
      vi.restoreAllMocks();
    }
  });
});

describe('#729 PR-3 correction 2 (G1-b, E-10) — the built realm mcp, fresh, reads its run for the masking', () => {
  it("the first call of a fresh process hides a declared value in a run's stored reason; a failed project's run reads load_failed", async () => {
    const home = join(root, 'home');
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    for (const d of [home, good, bad]) mkdirSync(d);
    manifest(good, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    // A manifest naming a secret its dotenv file does not hold: its load fails.
    manifest(bad, MANIFEST, '');
    const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    await workflows.register(definitionAt(good, { id: 'good-729' }));
    await workflows.register(definitionAt(bad, { id: 'bad-729' }));
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const goodRun = (await runs.create({ workflowId: 'good-729', workflowVersion: 1, params: {} }))
      .run.id;
    await abandonRun(runs, goodRun, `stopped: the token ${SECRET} was rejected`);
    const badRun = (await runs.create({ workflowId: 'bad-729', workflowVersion: 1, params: {} }))
      .run.id;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Rebuild before the break: this cell runs the built CLI.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      env: { ...env, HOME: home },
      cwd: root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'g1b-729', version: '0' });
    await client.connect(transport);
    try {
      const read = async (runId: string) => {
        const raw = (await client.callTool({
          name: 'get_run_state',
          arguments: { run_id: runId },
        })) as { content: Array<{ text: string }> };
        return JSON.parse(raw.content[0]!.text) as {
          terminal_reason?: string;
          disclosure?: { declared?: string; declared_cause?: string };
        };
      };
      const first = await read(goodRun);
      const second = await read(badRun);
      // (a) red when the server's run store does not reach the masking (the first call reads no run:
      //     no project, `unknown`/`no_manifest`, the value shown); (b) prints the shown reason (a
      //     marker) and each reply's standing.
      expect({
        reason: first.terminal_reason,
        first: [first.disclosure?.declared, first.disclosure?.declared_cause ?? null],
        second: [second.disclosure?.declared, second.disclosure?.declared_cause ?? null],
      }).toEqual({
        reason: 'stopped: the token [REDACTED] was rejected',
        first: ['resolved', null],
        second: ['unknown', 'load_failed'],
      });
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('#729 PR-3 correction 2 (C9) — the malformed-reference load error, as the CLI prints it', () => {
  it("a malformed reference's fragment is hidden in the load error a piped command prints", () => {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    // A key that is no credential name, so the line's own words show; a fragment holding a fake.
    manifest(
      project,
      'version: 1\nadapters:\n  svc:\n    use: github\n    config: { endpoint: "${secret:fakeFragment0729x}" }\n',
    );
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: c9\nname: c9\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    // Rebuild before the break: this cell runs the built CLI.
    const r = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'validate', 'workflow.yaml'], {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = r.stderr.split('\n').find((l) => l.includes('malformed secret reference')) ?? '';
    // (a) red when a `${secret:…}` fragment the manifest grammar does not accept is read as a
    //     reference (D-3's identifier: the fragment shows); (b) prints the line (a fake and a marker).
    expect(line).toBe(
      "  malformed secret reference '${secret:[REDACTED]' at adapters.svc.config.endpoint — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.",
    );
  });
});

// ── #729 PR-3 correction 2: the CLI (C1–C5, G7) ───────────────────────────────────────────────────

/** The built CLI, piped, in a fresh process. */
function piped(args: string[], env: Record<string, string>, cwd: string = root) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** A run of a registered workflow whose stored copy is damaged (not JSON), in `home`'s store. */
async function damagedCopyRun(home: string): Promise<{ runId: string; file: string }> {
  const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  await workflows.register(definitionAt(undefined, { id: 'blockedwf' }));
  const file = join(home, '.realm', 'workflows', 'blockedwf.json');
  writeFileSync(file, 'not json');
  const runs = new JsonFileStore(join(home, '.realm', 'runs'));
  const runId = (await runs.create({ workflowId: 'blockedwf', workflowVersion: 1, params: {} })).run
    .id;
  return { runId, file };
}

describe("#729 PR-3 correction 2 (C1) — realm's own words print whole", () => {
  it('piped `realm mcp --check` shows the gate-answers value while another variable holds the same word', () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const r = piped(['mcp', '--check', '--gate-answers', 'withheld'], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      MODE_X: 'withheld',
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('Gate answers over MCP:')) ?? '';
    // (a) red when the value prints as plain text (the shadow rule hides it: `[REDACTED]`); (b)
    //     prints the line's start.
    expect(line.slice(0, 'Gate answers over MCP: withheld ('.length)).toBe(
      'Gate answers over MCP: withheld (',
    );
  }, 60_000);

  it('piped inspect shows the phase while another variable holds the same word', async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    await workflows.register(definitionAt(undefined));
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const runId = (await runs.create({ workflowId: 'records-729', workflowVersion: 1, params: {} }))
      .run.id;
    await abandonRun(runs, runId, 'Held.');
    const r = piped(['run', 'inspect', runId], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      STATUS_X: 'abandoned',
    });
    // (a) red when the phase prints as plain text (`Phase: [REDACTED]`); (b) prints the line.
    expect(r.stdout.split('\n').find((l) => l.startsWith('Phase:'))).toBe('Phase: abandoned');
  }, 60_000);

  it('the damaged-copy repair command prints whole on every surface, and runs as copied', async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runId, file } = await damagedCopyRun(home);
    // HOME is not listed in REALM_NOT_SECRET: a path under it is hidden in a log (R31: except
    // inside a printed command).
    const env = { HOME: home };
    const command = `rm ${file}`;
    const inspected = piped(['run', 'inspect', runId], env);
    const advanced = piped(['run', 'advance', runId], env);
    const validated = piped(['workflow', 'validate', '--registered', 'blockedwf'], env);
    // Correction 3: the command as each surface PRINTED it — `rm` and the word after it, ended by
    // the bracket, space or line end around it — never the test's own string.
    const printedCommand = (r: { stdout: string; stderr: string }): string | undefined =>
      `${r.stdout}${r.stderr}`.match(/\brm [^\s)]+/)?.[0];
    const surfaces = {
      inspect: printedCommand(inspected),
      advance: printedCommand(advanced),
      validate: printedCommand(validated),
    };
    // It runs as copied from the printed output: the copy is gone.
    spawnSync('sh', ['-c', surfaces.inspect ?? 'false']);
    // (a) red when the command prints as plain text (the path under HOME is hidden: `rm
    //     [REDACTED]/…`), or prints with anything glued to it (the copied command removes nothing);
    //     (b) prints each surface's printed command (a fake path) and whether the copy is gone.
    expect({ ...surfaces, removed: !existsSync(file) }).toEqual({
      inspect: command,
      advance: command,
      validate: command,
      removed: true,
    });
  }, 60_000);

  it("G7: the repair's command reaches the CLI as its own field (printed whole in a log); the agent's copy has its path masked", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runId, file } = await damagedCopyRun(home);
    // Correction 3 (H-7): the run's record names an intact manifest, so its declared values are
    // known and nothing is withheld (a damaged copy whose record names none reads `load_failed`,
    // and the door withholds its reply's diagnostics: the H-11' cell).
    const project = join(root, 'g7-project');
    mkdirSync(project);
    manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const recorded = await runs.get(runId);
    const manifestPath = join(project, 'realm.yaml');
    await runs.update({
      ...recorded,
      extension_identity: [
        {
          captured_at: '2024-01-01T00:00:00.000Z',
          modules: [],
          tree: {
            roots: [project],
            rules: 'r',
            file_count: 0,
            total_bytes: 0,
            tree_hash: 'x',
            truncated: false,
          },
          coverage: 'dir_tree_v1',
          manifest: {
            path: manifestPath,
            content_hash: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
          },
          secret_names: ['SVC_TOKEN'],
        },
      ],
    } as unknown as RunRecord);
    const inspected = piped(['run', 'inspect', runId], { HOME: home });
    // Rebuild before the break: this cell runs the built CLI. Its environment is its own (the
    // suite's pins would list HOME as not secret).
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      cwd: root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'g7-729', version: '0' });
    await client.connect(transport);
    const reply = await client
      .callTool({ name: 'execute_step', arguments: { run_id: runId, command: 'a', params: {} } })
      .then((raw) => (raw as { content: Array<{ text: string }> }).content[0]!.text)
      .finally(() => client.close());
    // Non-vacuity: the agent's reply names the repair.
    // (a) red when the command is not carried as its own field (the log hides its path); (b)
    //     prints three booleans.
    expect({
      log: inspected.stdout.includes(`rm ${file}`),
      agentNamesRepair: reply.includes('rm [REDACTED]/.realm/workflows/blockedwf.json'),
      agentPathShown: reply.includes(file),
    }).toEqual({ log: true, agentNamesRepair: true, agentPathShown: false });
  }, 60_000);

  it('the record table classes `terminal_reason` by its value: a fixed sentence is shown, a templated one is masked', async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    await workflows.register(definitionAt(undefined));
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    // A run that completed: its reason is core's fixed sentence.
    const done = (await runs.create({ workflowId: 'records-729', workflowVersion: 1, params: {} }))
      .run.id;
    await executeStep(runs, definitionAt(undefined), {
      runId: done,
      command: 'a',
      input: {},
      dispatcher: async () => ({ ok: true }),
    });
    // A run abandoned with a reason that starts with the CLI's fixed sentence and holds a value.
    const mixed = (await runs.create({ workflowId: 'records-729', workflowVersion: 1, params: {} }))
      .run.id;
    await abandonRun(runs, mixed, `Abandoned via realm run abandon ${ENV_CANARY}`);
    const env = {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      STATUS_X: 'completed',
      APP_CANARY: ENV_CANARY,
    };
    const exported = (runId: string) => {
      const out = join(root, `${runId}.json`);
      piped(['run', 'export', runId, '--out', out, '--accept-partial-disclosure'], env);
      return existsSync(out)
        ? (JSON.parse(readFileSync(out, 'utf8')) as { run: { terminal_reason?: string } }).run
            .terminal_reason
        : '<no export>';
    };
    // (a) red when the row is `bounded` whatever the value (the fixed sentence's word is hidden:
    //     `Workflow [REDACTED].`), or a reason that only starts with a fixed sentence is classed a
    //     fact (the value shows); (b) prints both reasons (fake text and a marker).
    expect({ completed: exported(done), templated: exported(mixed) }).toEqual({
      completed: 'Workflow completed.',
      templated: 'Abandoned via realm run abandon [REDACTED]',
    });
  }, 60_000);
});

describe('#729 PR-3 correction 2 (C2) — inspect shows a question as every other surface does', () => {
  it('piped inspect of an open gate shows the question at the declared tier, and its line says so', async () => {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
    const def = definitionAt(project, {
      id: 'asks-729',
      steps: {
        g: {
          description: 'G.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: {
            choices: ['approve', 'reject'],
            message: 'Ship to {{ run.params.region }} with {{ run.params.key }}?',
          },
        },
      },
    } as Partial<WorkflowDefinition>);
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const runId = (
      await runs.create({
        workflowId: 'asks-729',
        workflowVersion: 1,
        params: { region: ENV_CANARY, key: SECRET },
      })
    ).run.id;
    await executeStep(runs, def, {
      runId,
      command: 'g',
      input: {},
      dispatcher: async () => ({ preview: 'x' }),
    });
    const r = piped(['run', 'inspect', runId], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      APP_CANARY: ENV_CANARY,
    });
    const question = r.stdout.split('\n').find((l) => l.startsWith('  Question:')) ?? '';
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    // (a) red when the question prints as plain text (at the log's tier the environment value is
    //     hidden too, and the line has no question clause); (b) prints the question line (fake
    //     values and a marker) and the line's end.
    expect({ question, clause: last.endsWith('; question: declared tier only.') }).toEqual({
      question: `  Question: "Ship to ${ENV_CANARY} with [REDACTED]?"`,
      clause: true,
    });
  }, 60_000);
});

describe('#729 PR-3 correction 2 (C4) — a drive refused at the extension load prints its Disclosure line', () => {
  it('`realm agent --workflow` with a manifest that fails to load', () => {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    manifest(project, 'version: 1\nnot_a_key: true\n');
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: c4\nname: c4\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    const r = piped(
      [
        'agent',
        '--workflow',
        'workflow.yaml',
        '--provider',
        'anthropic',
        '--model',
        'fake-model',
        '--log-mode',
      ],
      { HOME: home, REALM_NOT_SECRET: 'HOME', ANTHROPIC_API_KEY: 'fake-key-0729' },
      project,
    );
    const out = `${r.stdout}${r.stderr}`;
    // Non-vacuity: the drive was refused at the load.
    // (a) red when the early exit skips the line (it is printed only in the drive's `finally`);
    //     (b) prints two booleans.
    expect({
      refused: out.includes('Error loading extensions:'),
      line: out.split('\n').some((l) => l.startsWith('Disclosure:')),
    }).toEqual({ refused: true, line: true });
  }, 60_000);
});

describe('#729 PR-3 correction 2 (C5) — a misspelt name in a manifest’s `disclosure.not_secret` warns', () => {
  it('on validate, inspect, export and agent: four clauses, the manifest named', async () => {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    manifest(project, 'version: 1\ndisclosure:\n  not_secret: [FAKE_MISSPELT_0729]\n');
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: c5\nname: c5\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    const def = definitionAt(project, { id: 'c5' });
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const runId = (await runs.create({ workflowId: 'c5', workflowVersion: 1, params: {} })).run.id;
    await abandonRun(runs, runId, 'Held.');
    const env = { HOME: home, REALM_NOT_SECRET: 'HOME', ANTHROPIC_API_KEY: 'fake-key-0729' };
    const warning =
      `Warning: the manifest ${join(project, 'realm.yaml')} lists 'FAKE_MISSPELT_0729' under disclosure.not_secret, which is not set in this environment, ` +
      `so listing it has no effect. Fix the name, or remove it from disclosure.not_secret in ${join(project, 'realm.yaml')}. ` +
      'Nothing else needs to change; a listed name takes effect once it is set.';
    const said = (r: { stdout: string; stderr: string }) =>
      `${r.stdout}${r.stderr}`.includes(warning);
    // (a) red when the warning is removed (a misspelt name is silent); (b) prints a boolean per
    //     surface.
    expect({
      validate: said(piped(['workflow', 'validate', 'workflow.yaml'], env, project)),
      inspect: said(piped(['run', 'inspect', runId], env)),
      export: said(
        piped(
          ['run', 'export', runId, '--out', join(root, 'c5.json'), '--accept-partial-disclosure'],
          env,
        ),
      ),
      // A drive of the workflow: the project's extensions load before the run; the provider's
      // address is a closed local port, so no request leaves this machine.
      agent: said(
        piped(
          [
            'agent',
            '--workflow',
            'workflow.yaml',
            '--provider',
            'anthropic',
            '--model',
            'fake-model',
            '--log-mode',
          ],
          { ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
          project,
        ),
      ),
    }).toEqual({ validate: true, inspect: true, export: true, agent: true });
  }, 60_000);
});

// ── #729 PR-3 correction 3 ───────────────────────────────────────────────────────────────────────

/**
 * A run whose record names its project's manifest (as the loader writes it since v0.14.0) and whose
 * workflow copy is then damaged (not JSON). Its params and a step's input and output hold the
 * declared value.
 */
async function damagedCopyWithRecordedManifest(): Promise<{ home: string; runId: string }> {
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
  const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  await workflows.register(definitionAt(project, { id: 'damaged-729' }));
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const { run } = await store.create({
    workflowId: 'damaged-729',
    workflowVersion: 1,
    params: { key: SECRET },
  });
  const path = join(project, 'realm.yaml');
  await store.update({
    ...run,
    completed_steps: ['a'],
    evidence: [
      {
        step_id: 'a',
        started_at: '2024-01-01T00:00:00.000Z',
        completed_at: '2024-01-01T00:00:01.000Z',
        duration_ms: 1000,
        input_summary: { key: SECRET },
        output_summary: { note: SECRET },
        status: 'success',
        evidence_hash: 'abc123def456789012345678901234567890abcd',
      },
    ],
    extension_identity: [
      {
        captured_at: '2024-01-01T00:00:00.000Z',
        modules: [],
        tree: {
          roots: [project],
          rules: 'r',
          file_count: 0,
          total_bytes: 0,
          tree_hash: 'x',
          truncated: false,
        },
        coverage: 'dir_tree_v1',
        manifest: {
          path,
          content_hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
        },
        secret_names: ['SVC_TOKEN'],
      },
    ],
  } as unknown as RunRecord);
  writeFileSync(join(home, '.realm', 'workflows', 'damaged-729.json'), 'not json');
  return { home, runId: run.id };
}

describe("#729 PR-3 correction 3 (H-7) — a damaged copy: the manifest the run's record names is read", () => {
  it('piped inspect, outside the project, hides the declared value and reads resolved', async () => {
    const { home, runId } = await damagedCopyWithRecordedManifest();
    // From outside the project, so no `.env` is loaded and only the record's manifest can declare
    // the value (PR3-R3-MA1-04).
    const r = piped(['run', 'inspect', runId], { HOME: home, REALM_NOT_SECRET: 'HOME' });
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    // (a) red when the record's manifest is not read while the copy cannot be (the state reads
    //     `unknown (load failed)` and the step's input and output show the declared value); (b)
    //     prints the exit code, a boolean and the receipt line.
    expect({ code: r.status, leaked: `${r.stdout}${r.stderr}`.includes(SECRET), last }).toEqual({
      code: 0,
      leaked: false,
      last: 'Disclosure: declared values resolved; environment swept; hidden 2 declared, 0 environment, 0 by pattern; 0 not checked; 0 too short to hide.',
    });
  }, 60_000);
});

describe("#729 PR-3 correction 3 (H-8'') — realm's fixed words print whole at the six sites", () => {
  /** A registered workflow (one agent step, or one auto step), and the store for its runs. */
  async function stores(home: string, auto = false) {
    const definition = definitionAt(undefined, {
      steps: { a: { description: 'A.', execution: auto ? 'auto' : 'agent', depends_on: [] } },
    } as Partial<WorkflowDefinition>);
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definition);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const create = async () =>
      (await runs.create({ workflowId: 'records-729', workflowVersion: 1, params: {} })).run.id;
    return { definition, runs, create };
  }

  it("inspect's `Cause:` prints a fixed sentence whole while a variable holds its word", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { definition, runs, create } = await stores(home);
    const done = await create();
    await executeStep(runs, definition, {
      runId: done,
      command: 'a',
      input: {},
      dispatcher: async () => ({ ok: true }),
    });
    const ended = await create();
    await abandonRun(runs, ended, 'Abandoned via realm run abandon');
    const cause = (runId: string, word: string) =>
      piped(['run', 'inspect', runId], { HOME: home, REALM_NOT_SECRET: 'HOME', STATUS_X: word })
        .stdout.split('\n')
        .find((l) => l.startsWith('Cause:'));
    // A word of 8 or more characters: a shorter environment value is not masked at all.
    // (a) red when the reason prints as plain text (`Workflow [REDACTED].`, `[REDACTED] via realm
    //     run abandon`); (b) prints the two lines.
    expect([cause(done, 'completed'), cause(ended, 'Abandoned')]).toEqual([
      'Cause: Workflow completed.',
      'Cause: Abandoned via realm run abandon',
    ]);
  }, 60_000);

  it("abandon's `Reason:` prints the default sentence whole while a variable holds its word", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { create } = await stores(home);
    const runId = await create();
    const r = piped(['run', 'abandon', runId], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      // 8 or more characters: a shorter environment value is not masked at all.
      STATUS_X: 'Abandoned',
    });
    const first = r.stdout.split('\n')[0] ?? '';
    // (a) red when the reason prints as plain text (`[REDACTED] via realm run abandon.`); (b)
    //     prints the first line's end.
    expect(first.slice(first.indexOf(' Reason: '))).toBe(
      ' Reason: Abandoned via realm run abandon.',
    );
  }, 60_000);

  it("run list's phase column prints the phase whole while a variable holds it", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runs, create } = await stores(home);
    const runId = await create();
    await abandonRun(runs, runId, 'Held.');
    const r = piped(['run', 'list'], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      STATUS_X: 'abandoned',
    });
    const row = r.stdout.split('\n').find((l) => l.startsWith(runId)) ?? '';
    // (a) red when the column prints as plain text (`[REDACTED]`); (b) prints the row's third
    //     column.
    expect(row.split(/\s{2,}/)[2]).toBe('abandoned');
  }, 60_000);

  it("advance's last line prints the phase whole while a variable holds it", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { create } = await stores(home, true);
    const runId = await create();
    const r = piped(['run', 'advance', runId], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      STATUS_X: 'completed',
    });
    // (a) red when the phase prints as plain text (`phase '[REDACTED]'`); (b) prints the exit code
    //     and the last line.
    expect([r.status, r.stdout.trim().split('\n').at(-1)]).toEqual([
      0,
      `Run ${runId}: phase 'completed'`,
    ]);
  }, 60_000);

  it("`--check`'s value line prints `withheld` whole, measured and configured, while a variable holds it", () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const valueLine = (args: string[], env: Record<string, string>) =>
      piped(['mcp', '--check', ...args], { HOME: home, MODE_X: 'withheld', ...env })
        .stdout.split('\n')
        .find((l) => l.includes('The gate-answers value:'))
        ?.trim()
        .split(/[(,]/)[0];
    // (a) red when the value prints as plain text inside its sentence (`[REDACTED]`); (b) prints
    //     each line's start.
    expect([
      valueLine(['--gate-answers', 'withheld'], {}),
      valueLine([], { REALM_MCP_GATE_ANSWERS: 'withheld' }),
    ]).toEqual(['The gate-answers value: withheld ', 'The gate-answers value: withheld']);
  }, 60_000);

  it("`agent --run-id`'s ended-run sentence prints the phase whole while a variable holds it", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runs, create } = await stores(home);
    const runId = await create();
    await abandonRun(runs, runId, 'Held.');
    const r = piped(['agent', '--run-id', runId, '--model', 'anthropic:fake-model-0729'], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
      ANTHROPIC_API_KEY: 'fake-key-0729',
      STATUS_X: 'abandoned',
    });
    // (a) red when the CLI's carrier passes no writer context (`([REDACTED])`); (b) prints the
    //     exit code and the first line of the error.
    expect([r.status, r.stderr.split('\n').find((l) => l.startsWith('Error:'))]).toEqual([
      1,
      `Error: Run ${runId} has already ended (abandoned): an operator ended it.`,
    ]);
  }, 60_000);
});

describe("#729 PR-3 correction 3 (H-9) — realm's own text never puts a credential word before its colon", () => {
  it("`--check`'s condition-2 line prints its reading whole, with no variable holding it", () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const line =
      piped(['mcp', '--check'], { HOME: home })
        .stdout.split('\n')
        .find((l) => l.includes("This login can become Realm's service user")) ?? '';
    const reading = line.slice(line.indexOf(': ') + 2).split(/[ (]/)[0];
    // (a) red when the words before the colon end with `password` (the name rule hides the
    //     reading: `[REDACTED]`); (b) prints the reading.
    // `not` begins #819 follow-up 2's `not measured (…)` reading.
    expect(['yes', 'no', 'unknown', 'not', 'configured,']).toContain(reading);
  }, 60_000);

  it('the malformed-reference message, piped, at its three sites under credential-named keys: the words whole, the path after them, one marker', () => {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    manifest(
      project,
      [
        'version: 1',
        'adapters:',
        '  svc:',
        '    use: "github${secret:fakeUse0729x}"',
        '    config: { token: "${secret:fakeCfg0729x}" }',
        'notifiers:',
        '  slack_gate:',
        '    type: slack',
        '    config: { bot_token: "${secret:fakeSlack0729x}" }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: h9\nname: h9\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    const r = piped(['workflow', 'validate', 'workflow.yaml'], { HOME: home }, project);
    const FORM = ' — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.';
    // (a) red when a key path precedes realm's words (`adapters.svc.config.token: [REDACTED] secret
    //     reference …`: the credential-named last key makes the sentence its value); (b) prints the
    //     three lines (markers and fake paths).
    expect(r.stderr.split('\n').filter((l) => l.includes('secret reference'))).toEqual([
      "  malformed secret reference '${secret:[REDACTED]' at adapters.svc.use.",
      `  malformed secret reference '\${secret:[REDACTED]' at adapters.svc.config.token${FORM}`,
      `  malformed secret reference '\${secret:[REDACTED]' at notifiers.slack_gate.config.bot_token${FORM}`,
    ]);
  });
});

describe('#729 PR-3 correction 3 (H-10) — the receipt says why the declared part is unknown', () => {
  it('a drive refused at the load reads `load failed` for a manifest that exists, invalid or with a secret it cannot resolve', () => {
    const line = (yaml: string, name: string) => {
      const home = join(root, `home-${name}`);
      const project = join(root, `proj-${name}`);
      mkdirSync(home);
      mkdirSync(project);
      manifest(project, yaml, '');
      writeFileSync(
        join(project, 'workflow.yaml'),
        'id: h10\nname: h10\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
      );
      const r = piped(
        [
          'agent',
          '--workflow',
          'workflow.yaml',
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--log-mode',
        ],
        { HOME: home, REALM_NOT_SECRET: 'HOME', ANTHROPIC_API_KEY: 'fake-key-0729' },
        project,
      );
      const out = `${r.stdout}${r.stderr}`;
      return [
        out.includes('Error loading extensions:'),
        out
          .split('\n')
          .find((l) => l.startsWith('Disclosure:'))
          ?.split(';')[0],
      ];
    };
    // (a) red when the writer is not told the manifest failed (`unknown (no manifest)`); (b) prints
    //     whether the drive was refused at the load, and the receipt's first clause.
    expect([
      line('version: 1\nnot_a_key: true\n', 'invalid'),
      line(MANIFEST, 'unresolved'),
    ]).toEqual([
      [true, 'Disclosure: declared values unknown (load failed)'],
      [true, 'Disclosure: declared values unknown (load failed)'],
    ]);
  }, 60_000);
});

describe('#729 PR-3 correction 3 — small items', () => {
  it("the `not_secret` warning's manifest path prints whole in a log, under an unlisted HOME", () => {
    const home = join(root, 'home');
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    manifest(project, 'version: 1\ndisclosure:\n  not_secret: [FAKE_MISSPELT_0729]\n');
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: w9\nname: w9\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    // HOME is not listed in REALM_NOT_SECRET: a path under it is hidden in a log, except a fact.
    const r = piped(['workflow', 'validate', 'workflow.yaml'], { HOME: home }, project);
    const line = r.stderr.split('\n').find((l) => l.startsWith('Warning: the manifest ')) ?? '';
    // (a) red when the path is printed as text (`[REDACTED]/proj/realm.yaml`); (b) prints the
    //     path the line names first.
    expect(line.slice('Warning: the manifest '.length).split(' ')[0]).toBe(
      join(project, 'realm.yaml'),
    );
  }, 60_000);
});

// ── #729 PR-3 correction 3 (H-7'', H-11'): a failed or changed manifest withholds ────────────────

/**
 * A run whose step input, output, params and open question hold the declared value, its record
 * naming the project's manifest. `gone` and `unreadable` then damage the copy and remove the
 * manifest (`partial` / `manifest_changed`) or make it invalid (`unknown` / `load_failed`);
 * `no_manifest` registers the workflow with no project (nothing was ever declared). Correction 4:
 * `intact` records the manifest and damages nothing (`resolved`).
 */
async function withheldRun(
  state: 'gone' | 'unreadable' | 'no_manifest' | 'intact',
  plainOutputs = false,
  tag = '',
): Promise<{ home: string; runId: string }> {
  // Correction 4 (I-9b): `plainOutputs` runs the steps with outputs that hold no declared value, so
  // their hashes print whole where values print whole; `tag` names a second fixture of one state.
  const output = plainOutputs ? 'FAKEplain0729c4' : SECRET;
  const home = join(root, `home-${state}${plainOutputs ? '-plain' : ''}${tag}`);
  const project = join(root, `project-${state}${plainOutputs ? '-plain' : ''}${tag}`);
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
  const definition = definitionAt(state === 'no_manifest' ? undefined : project, {
    id: 'held-729',
    steps: {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      g: {
        description: 'G.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['a'],
        gate: { choices: ['approve', 'reject'], message: 'Ship with key {{ run.params.key }}?' },
      },
    },
  } as Partial<WorkflowDefinition>);
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definition);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const { run } = await store.create({
    workflowId: 'held-729',
    workflowVersion: 1,
    params: { key: SECRET },
  });
  await executeStep(store, definition, {
    runId: run.id,
    command: 'a',
    input: { key: output },
    dispatcher: async (_c, input) => input,
  });
  await executeStep(store, definition, {
    runId: run.id,
    command: 'g',
    input: {},
    dispatcher: async () => ({ note: output }),
  });
  if (state !== 'no_manifest') {
    const path = join(project, 'realm.yaml');
    const recorded = await store.get(run.id);
    await store.update({
      ...recorded,
      extension_identity: [
        {
          captured_at: '2024-01-01T00:00:00.000Z',
          modules: [],
          tree: {
            roots: [project],
            rules: 'r',
            file_count: 0,
            total_bytes: 0,
            tree_hash: 'x',
            truncated: false,
          },
          coverage: 'dir_tree_v1',
          manifest: {
            path,
            content_hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
          },
          secret_names: ['SVC_TOKEN'],
        },
      ],
    } as unknown as RunRecord);
    if (state !== 'intact') {
      writeFileSync(join(home, '.realm', 'workflows', 'held-729.json'), 'not json');
      if (state === 'gone') rmSync(path);
      else writeFileSync(path, 'version: 1\nnot_a_key: true\n');
    }
  }
  return { home, runId: run.id };
}

/** A failed attempt on `runId` whose problem's message holds the declared value. */
async function failedAttemptHolding(home: string, runId: string): Promise<void> {
  const { FailedAttemptStore, buildFailedAttemptRecord, serializeFailedAttemptLine } =
    await import('@sensigo/realm');
  const rec = buildFailedAttemptRecord({
    run_id: runId,
    workflow_id: 'held-729',
    step_id: 'a',
    ts: '2026-10-18T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [
      {
        instancePath: '/key',
        schemaPath: '#/properties/key/enum',
        keyword: 'enum',
        message: `must not be ${SECRET}`,
        params: {},
      },
    ],
    params: {},
    trace_entry_count: 0,
  });
  await new FailedAttemptStore(join(home, '.realm', 'runs')).append(
    runId,
    serializeFailedAttemptLine({ ...rec }).line,
  );
}

describe("#729 PR-3 correction 3 (H-7'') — the read commands withhold a run's values under a failed or changed manifest", () => {
  const read = (home: string, args: string[]) =>
    piped(args, { HOME: home, REALM_NOT_SECRET: 'HOME' });
  const lineOf = (text: string, start: string) =>
    text
      .split('\n')
      .find((l) => l.trimStart().startsWith(start))
      ?.trim();

  it('inspect, manifest gone or unreadable: values as shapes, Input: too; the question withheld naming the cause and the flag; facts whole; export refuses', async () => {
    const shown = async (state: 'gone' | 'unreadable') => {
      const { home, runId } = await withheldRun(state);
      const r = read(home, ['run', 'inspect', runId]);
      const out = `${r.stdout}${r.stderr}`;
      const exported = read(home, ['run', 'export', runId, '--out', join(root, `${state}.json`)]);
      return {
        leaked: out.includes(SECRET),
        first: r.stdout.split('\n')[0]?.split(':')[0],
        question: lineOf(r.stdout, 'Question:'),
        input: lineOf(r.stdout, 'Input:'),
        facts: [
          lineOf(r.stdout, 'Run:') === `Run: ${runId}`,
          lineOf(r.stdout, 'Phase:'),
          r.stdout.includes('definition_unresolvable:'),
        ],
        exportRefused: [exported.status, `${exported.stderr}`.startsWith('Refusing to export')],
      };
    };
    // (a) red when values print as text (the declared value shows: the record's manifest is gone or
    //     invalid, so no member covers it), the question is shown, `Input:` is cut as text, or a
    //     fact is shaped; (b) prints booleans, the first line's head and the lines (shapes and
    //     realm's words).
    expect({ gone: await shown('gone'), unreadable: await shown('unreadable') }).toEqual({
      gone: {
        leaked: false,
        first: 'Values withheld (declared values changed)',
        question: 'Question: withheld (declared values changed — pass --accept-partial-disclosure)',
        input: 'Input:  ‹object, 1 key›',
        facts: [true, 'Phase: gate_waiting', true],
        exportRefused: [1, true],
      },
      unreadable: {
        leaked: false,
        first: 'Values withheld (declared values could not be read)',
        question:
          'Question: withheld (declared values could not be read — pass --accept-partial-disclosure)',
        input: 'Input:  ‹object, 1 key›',
        facts: [true, 'Phase: gate_waiting', true],
        exportRefused: [1, true],
      },
    });
  }, 120_000);

  it('inspect with --accept-partial-disclosure prints the values at the surface’s tier', async () => {
    const { home, runId } = await withheldRun('gone');
    const r = read(home, ['run', 'inspect', runId, '--accept-partial-disclosure']);
    // (a) red when the flag is ignored (the values stay shapes); (b) prints the two lines (the
    //     fake value is unknown to the masking here, by the flag's meaning).
    expect([lineOf(r.stdout, 'Input:'), lineOf(r.stdout, 'Question:')]).toEqual([
      `Input:  {"key":"${SECRET}"}`,
      `Question: "Ship with key ${SECRET}?"`,
    ]);
  }, 60_000);

  it('inspect of a run with no manifest entry (`no_manifest`) is not withheld', async () => {
    const { home, runId } = await withheldRun('no_manifest');
    const r = read(home, ['run', 'inspect', runId]);
    // (a) red when values are withheld for any state but `resolved` (the excluded cause too); (b)
    //     prints the first line's head and the Input: line.
    expect([r.stdout.split('\n')[0]?.split(':')[0], lineOf(r.stdout, 'Input:')]).toEqual([
      'Run',
      `Input:  {"key":"${SECRET}"}`,
    ]);
  }, 60_000);

  it('attempts reads the manifest as inspect does: withheld under a failed manifest, shown with the flag', async () => {
    const { home, runId } = await withheldRun('unreadable');
    await failedAttemptHolding(home, runId);
    const table = read(home, ['run', 'attempts', runId]);
    const json = read(home, ['run', 'attempts', runId, '--json']);
    const accepted = read(home, ['run', 'attempts', runId, '--accept-partial-disclosure']);
    const problem = (text: string) =>
      text
        .split('\n')
        .find((l) => l.startsWith('    '))
        ?.trim();
    // (a) red when attempts reads no manifest (nothing is withheld: `no manifest`), or its problem
    //     lines and --json summary are printed as text, or the flag is ignored; (b) prints booleans
    //     and the problem line (a shape, then the fake text).
    expect({
      said: table.stderr.startsWith('Values withheld (declared values could not be read)'),
      problemShaped: problem(table.stdout)?.startsWith('‹string, ') ?? false,
      tableLeaked: table.stdout.includes(SECRET),
      jsonLeaked: json.stdout.includes(SECRET),
      jsonParses: (() => {
        try {
          JSON.parse(json.stdout);
          return true;
        } catch {
          return false;
        }
      })(),
      accepted: problem(accepted.stdout)?.includes(SECRET),
    }).toEqual({
      said: true,
      problemShaped: true,
      tableLeaked: false,
      jsonLeaked: false,
      jsonParses: true,
      accepted: true,
    });
  }, 60_000);
});

describe("#729 PR-3 correction 3 (H-11') — the door withholds under a failed or changed manifest; never with none declared", () => {
  async function mcpRead(
    home: string,
    calls: (
      call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<unknown>,
    env: Record<string, string> = {},
  ): Promise<unknown> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ...env },
      cwd: root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'h11-729', version: '0' });
    await client.connect(transport);
    try {
      return await calls(async (name, args) => {
        const raw = (await client.callTool({ name, arguments: args })) as {
          content: Array<{ text: string }>;
        };
        return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
      });
    } finally {
      await client.close();
    }
  }

  it('a fresh realm mcp, a damaged copy with its manifest gone or invalid: values as shapes, the question withheld, the receipt says so', async () => {
    const shown = async (state: 'gone' | 'unreadable') => {
      const { home, runId } = await withheldRun(state);
      return mcpRead(home, async (call) => {
        const body = await call('get_run_state', { run_id: runId });
        const gate = body['pending_gate'] as { resolved_message?: string; preview?: unknown };
        const receipt = body['disclosure'] as Record<string, unknown>;
        return {
          leaked: JSON.stringify(body).includes(SECRET),
          params: body['params'],
          question: gate.resolved_message,
          receipt: [receipt['declared_cause'], receipt['question'], receipt['values']],
        };
      });
    };
    // (a) red when the door walks the reply as before (the declared value shows: no member covers
    //     it), or keeps the question; (b) prints a boolean, the params' shape, the sentence and the
    //     receipt's three fields.
    expect({ gone: await shown('gone'), unreadable: await shown('unreadable') }).toEqual({
      gone: {
        leaked: false,
        params: { key: '‹string, 23 characters›' },
        question: 'withheld (declared values changed)',
        receipt: ['manifest_changed', 'withheld', 'withheld'],
      },
      unreadable: {
        leaked: false,
        params: { key: '‹string, 23 characters›' },
        question: 'withheld (declared values could not be read)',
        receipt: ['load_failed', 'withheld', 'withheld'],
      },
    });
  }, 120_000);

  it("a damaged copy whose record names no manifest (`load_failed`): execute_step's diagnostics are withheld, its code and action stay facts", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runId } = await damagedCopyRun(home);
    const reply = (await mcpRead(home, async (call) =>
      call('execute_step', { run_id: runId, command: 'a', params: {} }),
    )) as Record<string, unknown>;
    const receipt = reply['disclosure'] as Record<string, unknown>;
    // (a) red when the door's error text is walked as before under a failed read (the sentence and
    //     its masked path show), or a fact is shaped, or (correction 4, I-10) `context_hint` is left
    //     a value shown as text; (b) prints the code, the action, whether the error text and the
    //     hint are shapes and the receipt's fields.
    expect({
      code: reply['error_code'],
      action: reply['agent_action'],
      errorShaped: String((reply['errors'] as unknown[])[0]).startsWith('‹string, '),
      hintShaped: String(reply['context_hint']).startsWith('‹string, '),
      receipt: [receipt['declared_cause'], receipt['values']],
    }).toEqual({
      code: 'RESOURCE_FORMAT_INVALID',
      action: 'stop',
      errorShaped: true,
      hintShaped: true,
      receipt: ['load_failed', 'withheld'],
    });
  }, 60_000);

  it('a create_workflow run on a fresh realm mcp (`no_manifest`): values at the agent tier, nothing withheld', async () => {
    const home = join(root, 'home-create');
    mkdirSync(home);
    const shown = (await mcpRead(
      home,
      async (call) => {
        const created = await call('create_workflow', {
          steps: [{ id: 'a', description: 'A.' }],
        });
        const started = await call('start_run', {
          workflow_id: (created['data'] as { workflow_id: string }).workflow_id,
          params: { plain: 'FAKEplain0729', env: ENV_CANARY },
        });
        const body = await call('get_run_state', { run_id: started['run_id'] });
        const receipt = body['disclosure'] as Record<string, unknown>;
        return {
          params: body['params'],
          receipt: [receipt['declared_cause'], receipt['values'] ?? null],
        };
      },
      { APP_CANARY: ENV_CANARY },
    )) as Record<string, unknown>;
    // (a) red when values are withheld for any state but `resolved` (the plain value is shaped);
    //     (b) prints the params (a fake word and a marker) and the receipt's fields.
    expect(shown).toEqual({
      params: { plain: 'FAKEplain0729', env: '[REDACTED]' },
      receipt: ['no_manifest', null],
    });
  }, 60_000);
});

// ── #729 PR-3 correction 4: the read commands (I-4…I-9) and the two un-read surfaces (I-11) ───────

/**
 * Correction 4 (I-11, I-7): a project whose manifest declares the canary; one run abandoned with
 * `reason` stored, one live run with no params and no step run. Each run's record names the manifest.
 * `gone` then damages the copy and removes the manifest (`partial` / `manifest_changed`).
 */
let endedCount = 0;
async function endedRuns(
  state: 'intact' | 'gone',
  reason: string,
): Promise<{ home: string; ended: string; live: string }> {
  endedCount += 1;
  const home = join(root, `home-ended-${state}-${endedCount}`);
  const project = join(root, `project-ended-${state}-${endedCount}`);
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(
    definitionAt(project, { id: 'ended-729' }),
  );
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const path = join(project, 'realm.yaml');
  const create = async (): Promise<string> => {
    const { run } = await store.create({ workflowId: 'ended-729', workflowVersion: 1, params: {} });
    await store.update({
      ...(await store.get(run.id)),
      extension_identity: [
        {
          captured_at: '2024-01-01T00:00:00.000Z',
          modules: [],
          tree: {
            roots: [project],
            rules: 'r',
            file_count: 0,
            total_bytes: 0,
            tree_hash: 'x',
            truncated: false,
          },
          coverage: 'dir_tree_v1',
          manifest: {
            path,
            content_hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
          },
          secret_names: ['SVC_TOKEN'],
        },
      ],
    } as unknown as RunRecord);
    return run.id;
  };
  const ended = await create();
  const live = await create();
  await abandonRun(store, ended, reason);
  if (state === 'gone') {
    writeFileSync(join(home, '.realm', 'workflows', 'ended-729.json'), 'not json');
    rmSync(path);
  }
  return { home, ended, live };
}

/**
 * Correction 4 (I-9): three runs of one workflow in one home, each with step `a` run (the same
 * output, `{ note: output }`). `a` and `c` record the project's manifest; `b` records one that is
 * gone (`manifest_changed`). Returns each run's evidence hash.
 */
async function diffRuns3(output: string): Promise<{
  home: string;
  ids: { a: string; b: string; c: string };
  hashes: { a: string; b: string; c: string };
}> {
  const home = join(root, `home-diff-${output.length}`);
  const project = join(root, `project-diff-${output.length}`);
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  manifest(project, MANIFEST, `SVC_TOKEN=${SECRET}\n`);
  const definition = definitionAt(project, { id: 'diff-729' });
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definition);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const real = join(project, 'realm.yaml');
  const run = async (manifestPath: string): Promise<[string, string]> => {
    const { run: created } = await store.create({
      workflowId: 'diff-729',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: created.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({ note: output }),
    });
    const recorded = await store.get(created.id);
    await store.update({
      ...recorded,
      extension_identity: [
        {
          captured_at: '2024-01-01T00:00:00.000Z',
          modules: [],
          tree: {
            roots: [project],
            rules: 'r',
            file_count: 0,
            total_bytes: 0,
            tree_hash: 'x',
            truncated: false,
          },
          coverage: 'dir_tree_v1',
          manifest: {
            path: manifestPath,
            content_hash: createHash('sha256').update(readFileSync(real)).digest('hex'),
          },
          secret_names: ['SVC_TOKEN'],
        },
      ],
    } as unknown as RunRecord);
    const hash = (await store.get(created.id)).evidence[0]!.evidence_hash;
    return [created.id, hash];
  };
  const [a, ha] = await run(real);
  const [b, hb] = await run(join(root, 'gone-729', 'realm.yaml'));
  const [c, hc] = await run(real);
  return { home, ids: { a, b, c }, hashes: { a: ha, b: hb, c: hc } };
}

describe('#729 PR-3 correction 4 — the read commands and the two un-read surfaces', () => {
  const read = (home: string, args: string[]) =>
    piped(args, { HOME: home, REALM_NOT_SECRET: 'HOME' });
  const problem = (text: string) =>
    text
      .split('\n')
      .find((l) => l.startsWith('    '))
      ?.trim();
  const receiptEnd = (stdout: string) => stdout.trim().split('\n').at(-1)?.split('; ').at(-1);

  it('I-4: attempts on a run record it cannot read: withheld, the first line names the failed read; the flag prints them (PR3-R4-R-06)', async () => {
    const home = join(root, 'home-damaged-record');
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await store.create({ workflowId: 'held-729', workflowVersion: 1, params: {} });
    writeFileSync(join(home, '.realm', 'runs', `${run.id}.json`), 'not json');
    await failedAttemptHolding(home, run.id);
    const plain = read(home, ['run', 'attempts', run.id]);
    const accepted = read(home, ['run', 'attempts', run.id, '--accept-partial-disclosure']);
    // (a) red when a record that cannot be read notes no standing (nothing is withheld: the
    //     problem prints as text and no line is said); (b) prints the exit codes, the first stderr
    //     line's head, the problem line's head and booleans.
    expect({
      status: [plain.status, accepted.status],
      said: plain.stderr.split('\n')[0]?.split(':')[0],
      problemShaped: problem(plain.stdout)?.startsWith('‹string, ') ?? false,
      leaked: plain.stdout.includes(SECRET),
      acceptedSaid: accepted.stderr.split('\n')[0]?.split(':')[0],
      acceptedShows: problem(accepted.stdout)?.includes(SECRET) ?? false,
    }).toEqual({
      status: [0, 0],
      said: 'Values withheld (declared values could not be read)',
      problemShaped: true,
      leaked: false,
      acceptedSaid:
        'Values shown on --accept-partial-disclosure (declared values could not be read)',
      acceptedShows: true,
    });
  }, 60_000);

  it('I-4 control: not found is not a failed read — a sidecar-only run prints at the tier with no line; no sidecar, the no-attempts line', async () => {
    const home = join(root, 'home-not-found');
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    const sidecarOnly = randomUUID();
    await failedAttemptHolding(home, sidecarOnly);
    const missing = randomUUID();
    const withRecord = read(home, ['run', 'attempts', sidecarOnly]);
    const without = read(home, ['run', 'attempts', missing]);
    // (a) red when "not found" notes `load_failed` too (the sidecar-only run says the line and its
    //     problem is a shape); (b) prints the stderr texts (empty), the problem line's head as a
    //     boolean and the no-attempts line (a fake id).
    expect({
      stderr: [withRecord.stderr, without.stderr],
      problemAtTier: problem(withRecord.stdout)?.includes(SECRET) ?? false,
      none: without.stdout.trim(),
    }).toEqual({
      stderr: ['', ''],
      problemAtTier: true,
      none: `No failed attempts recorded for run ${missing}.`,
    });
  }, 60_000);

  it('I-5: attempts says the withheld line only when it has attempts to show', async () => {
    const { home, runId } = await withheldRun('unreadable');
    const none = read(home, ['run', 'attempts', runId]);
    const noneAccepted = read(home, ['run', 'attempts', runId, '--accept-partial-disclosure']);
    // (a) red when the line is printed before the attempts are read (it prints with none); (b)
    //     prints the stderr texts (empty) and the no-attempts line (a fake id).
    expect({ stderr: [none.stderr, noneAccepted.stderr], out: none.stdout.trim() }).toEqual({
      stderr: ['', ''],
      out: `No failed attempts recorded for run ${runId}.`,
    });
  }, 60_000);

  it('I-6: under --accept-partial-disclosure, where values would be withheld, inspect, attempts and export say they were shown on the flag', async () => {
    const shown = async (state: 'gone' | 'unreadable') => {
      const { home, runId } = await withheldRun(state);
      await failedAttemptHolding(home, runId);
      const inspected = read(home, ['run', 'inspect', runId, '--accept-partial-disclosure']);
      const attempts = read(home, ['run', 'attempts', runId, '--accept-partial-disclosure']);
      const out = join(root, `c4-${state}.json`);
      const exported = read(home, [
        'run',
        'export',
        runId,
        '--out',
        out,
        '--accept-partial-disclosure',
      ]);
      const bundle = JSON.parse(readFileSync(out, 'utf8')) as {
        disclosure: Record<string, unknown>;
      };
      return {
        first: inspected.stdout.split('\n')[0],
        valueShown: inspected.stdout.includes(SECRET),
        receipt: receiptEnd(inspected.stdout),
        declaredOnly: inspected.stdout.includes('declared tier only'),
        attemptsFirst: attempts.stderr.split('\n')[0]?.split(':')[0],
        exportEnd: exported.stdout.trim().split('\n').at(-1)?.split('; ').at(-1),
        bundleSaysFlag: JSON.stringify(bundle.disclosure).includes('accept'),
      };
    };
    // (a) red when the words are not swapped under the flag (`declared tier only` beside a shown
    //     question), no first line names the flag, or export's last line does not; (b) prints the
    //     first lines (realm's words), booleans and the receipts' last clauses.
    expect({ gone: await shown('gone'), unreadable: await shown('unreadable') }).toEqual({
      gone: {
        first:
          'Values shown on --accept-partial-disclosure (declared values changed): Realm does not know every declared secret of this run; they print masked with what is known.',
        valueShown: true,
        receipt: 'question: shown with what is known (--accept-partial-disclosure).',
        declaredOnly: false,
        attemptsFirst: 'Values shown on --accept-partial-disclosure (declared values changed)',
        exportEnd: 'shown on --accept-partial-disclosure',
        bundleSaysFlag: false,
      },
      unreadable: {
        first:
          'Values shown on --accept-partial-disclosure (declared values could not be read): Realm does not know every declared secret of this run; they print masked with what is known.',
        valueShown: true,
        receipt: 'question: shown with what is known (--accept-partial-disclosure).',
        declaredOnly: false,
        attemptsFirst:
          'Values shown on --accept-partial-disclosure (declared values could not be read)',
        exportEnd: 'shown on --accept-partial-disclosure',
        bundleSaysFlag: false,
      },
    });
  }, 120_000);

  it('I-6 control: on a healthy run the flag changes nothing; attempts with no records says nothing', async () => {
    const { home, runId } = await withheldRun('intact');
    const inspected = read(home, ['run', 'inspect', runId, '--accept-partial-disclosure']);
    const attempts = read(home, ['run', 'attempts', runId, '--accept-partial-disclosure']);
    const exported = read(home, [
      'run',
      'export',
      runId,
      '--out',
      join(root, 'c4-intact.json'),
      '--accept-partial-disclosure',
    ]);
    // (a) red when the line or the words follow the flag alone (a healthy run says it was shown on
    //     the flag); (b) prints the first line's head, the receipt's and export's last clauses
    //     (realm's words) and a boolean.
    expect({
      first: inspected.stdout.split('\n')[0]?.split(':')[0],
      receipt: receiptEnd(inspected.stdout),
      attemptsSaid: attempts.stderr.includes('Values '),
      exportEnd: exported.stdout.trim().split('\n').at(-1)?.split('; ').at(-1),
    }).toEqual({
      first: 'Run',
      receipt: 'question: declared tier only.',
      attemptsSaid: false,
      exportEnd: 'question: declared tier only',
    });
  }, 60_000);

  it('I-7: a withheld run that shaped no value says `values withheld (none to show)`; one that shaped some counts them', async () => {
    const { home, live } = await endedRuns('gone', 'Held.');
    const empty = read(home, ['run', 'inspect', live]);
    const held = await withheldRun('gone');
    const some = read(held.home, ['run', 'inspect', held.runId]);
    // (a) red when the clause counts nothing (`values withheld: 0 shown as their type and size`);
    //     (b) prints the two receipts' last clauses.
    expect([receiptEnd(empty.stdout), receiptEnd(some.stdout)]).toEqual([
      'values withheld (none to show).',
      'values withheld: 6 shown as their type and size.',
    ]);
  }, 60_000);

  it("I-8: export's refusal for a run whose copy cannot be read and whose record names no manifest: repair the copy", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const { runId } = await damagedCopyRun(home);
    const copy = read(home, ['run', 'export', runId, '--out', join(root, 'r41.json')]);
    const inspected = read(home, ['run', 'inspect', runId]);
    const invalid = await withheldRun('unreadable');
    const invalidExport = read(invalid.home, [
      'run',
      'export',
      invalid.runId,
      '--out',
      join(root, 'inv.json'),
    ]);
    const none = await withheldRun('no_manifest');
    const noneExport = read(none.home, [
      'run',
      'export',
      none.runId,
      '--out',
      join(root, 'nm.json'),
    ]);
    const remedy = (stderr: string) =>
      stderr.split('. ').find((s) => /^(Repair|Restore|The run has no)/.test(s));
    // (a) red when the copy's arm is missing (the run is told to restore a manifest it never had),
    //     or widened to every failed read (the invalid manifest is told to repair the copy); (b)
    //     prints the three remedies (realm's words, a fake id) and whether inspect names a command.
    expect({
      copy: remedy(copy.stderr)?.trim(),
      inspectNamesCommand: /\brm [^\s)]+/.test(`${inspected.stdout}${inspected.stderr}`),
      invalid: remedy(invalidExport.stderr)?.split(',')[0],
      none: remedy(noneExport.stderr)?.split(',')[0],
    }).toEqual({
      copy: `Repair the run's workflow copy first (realm run inspect ${runId} names the command), or pass --accept-partial-disclosure to write it masked with what is known; the last line it prints then names the state.`,
      inspectNamesCommand: true,
      invalid: 'Restore the manifest the run used',
      none: 'The run has no manifest to restore',
    });
  }, 120_000);

  it('I-9: inspect prints an output hash as its type and size while values are withheld; the hex otherwise', async () => {
    const held = await withheldRun('gone');
    const withheld = read(held.home, ['run', 'inspect', held.runId]);
    const intact = await withheldRun('intact', true);
    const shown = read(intact.home, ['run', 'inspect', intact.runId]);
    const record = await new JsonFileStore(join(intact.home, '.realm', 'runs')).get(intact.runId);
    // inspect's other site: a step with two execution attempts prints a hash per attempt.
    const multi = await withheldRun('unreadable');
    const multiStore = new JsonFileStore(join(multi.home, '.realm', 'runs'));
    const stored = await multiStore.get(multi.runId);
    const firstA = stored.evidence.find((e) => e.step_id === 'a')!;
    await multiStore.update({
      ...stored,
      evidence: [{ ...firstA, status: 'error' }, ...stored.evidence],
    } as RunRecord);
    const attempts = read(multi.home, ['run', 'inspect', multi.runId])
      .stdout.split('\n')
      .filter((l) => l.includes('(attempt '));
    const hashes = (text: string) => text.match(/hash: (\S+(?: \d+ characters›)?)/g) ?? [];
    // (a) red when a hash line is printed as text under withholding at either site (its hex
    //     shows); (b) prints the hash lines (shapes, and the fake run's own hex prefixes).
    expect({
      withheld: hashes(withheld.stdout),
      attempts: attempts.flatMap(hashes),
      shown: hashes(shown.stdout),
    }).toEqual({
      withheld: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      attempts: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      shown: record.evidence.map((e) => `hash: ${e.evidence_hash.slice(0, 8)}`),
    });
  }, 60_000);

  it('I-9: diff reads both runs’ manifests — hashes as shapes while either is withheld, `=` whole; the flag prints them; two healthy runs as before', async () => {
    const { home, ids, hashes } = await diffRuns3('FAKEplain0729c4');
    const row = (stdout: string) => stdout.split('\n').find((l) => l.startsWith('a '));
    const withheld = read(home, ['run', 'diff', ids.a, ids.b]);
    const accepted = read(home, ['run', 'diff', ids.a, ids.b, '--accept-partial-disclosure']);
    const healthy = read(home, ['run', 'diff', ids.a, ids.c]);
    const cells = (stdout: string, a: string, b: string) => ({
      first: stdout.split('\n')[0]?.split(':')[0],
      shapes: (row(stdout)?.match(/‹string, 8 characters›/g) ?? []).length,
      hexes: [row(stdout)?.includes(a.slice(0, 8)), row(stdout)?.includes(b.slice(0, 8))],
      same: row(stdout)?.includes(' = ') ?? false,
    });
    // (a) red when diff reads no manifest (the hexes print under withholding), or the comparison
    //     mark is shaped; (b) prints line heads, counts and booleans (the fake runs' own hexes).
    expect({
      withheld: cells(withheld.stdout, hashes.a, hashes.b),
      accepted: cells(accepted.stdout, hashes.a, hashes.b),
      healthy: cells(healthy.stdout, hashes.a, hashes.c),
    }).toEqual({
      withheld: {
        first: 'Values withheld (declared values changed)',
        shapes: 2,
        hexes: [false, false],
        same: true,
      },
      accepted: {
        first: 'Values shown on --accept-partial-disclosure (declared values changed)',
        shapes: 0,
        hexes: [true, true],
        same: true,
      },
      healthy: { first: 'Diff', shapes: 0, hexes: [true, true], same: true },
    });
  }, 120_000);

  it('I-9b: inspect prints the hash of an output the law hid anything inside as its type and size, piped and on a terminal', async () => {
    const { home, runId } = await withheldRun('intact');
    const piped_ = read(home, ['run', 'inspect', runId]);
    const q = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, CLI_ENTRY, 'run', 'inspect', runId];
    const argv =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', ...command]
        : ['-qec', command.map(q).join(' '), '/dev/null'];
    const terminal = spawnSync('script', argv, {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        REALM_NOT_SECRET: 'HOME',
        NO_COLOR: '1',
        SHELL: '/bin/sh',
      },
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    }).stdout.replaceAll('\r', '');
    const hashes = (text: string) => text.match(/hash: (\S+(?: \d+ characters›)?)/g) ?? [];
    // inspect's per-attempt site: a step with two execution attempts, its output's value hidden.
    const multi = await withheldRun('intact', false, 'multi');
    const multiStore = new JsonFileStore(join(multi.home, '.realm', 'runs'));
    const stored = await multiStore.get(multi.runId);
    const firstA = stored.evidence.find((e) => e.step_id === 'a')!;
    await multiStore.update({
      ...stored,
      evidence: [{ ...firstA, status: 'error' }, ...stored.evidence],
    } as RunRecord);
    const attempts = read(multi.home, ['run', 'inspect', multi.runId])
      .stdout.split('\n')
      .filter((l) => l.includes('(attempt '));
    // (a) red when either of inspect's hash sites does not ask the law about its output (the hex
    //     beside the hidden value); (b) prints the hash lines (shapes).
    expect({
      piped: hashes(piped_.stdout),
      terminal: hashes(terminal),
      attempts: attempts.flatMap(hashes),
    }).toEqual({
      piped: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      terminal: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      attempts: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
    });
  }, 60_000);

  it('I-9b: diff of two runs whose outputs the law hid inside: both hash columns as shapes, `=` whole', async () => {
    const { home, ids, hashes } = await diffRuns3(SECRET);
    const healthy = read(home, ['run', 'diff', ids.a, ids.c]);
    const row = healthy.stdout.split('\n').find((l) => l.startsWith('a '));
    // (a) red when diff's hash columns do not ask the law about each run's output (the hexes show);
    //     (b) prints the first line's head, a count and booleans.
    expect({
      first: healthy.stdout.split('\n')[0]?.split(':')[0],
      shapes: (row?.match(/‹string, 8 characters›/g) ?? []).length,
      hexes: [row?.includes(hashes.a.slice(0, 8)), row?.includes(hashes.c.slice(0, 8))],
      same: row?.includes(' = ') ?? false,
    }).toEqual({ first: 'Diff', shapes: 2, hexes: [false, false], same: true });
  }, 120_000);

  it("I-11: abandon reads the run's manifest — a stored reason masked with its declared values; its shape and a line naming inspect's flag while withheld", async () => {
    const reason = `upstream refused key ${SECRET}`;
    const intact = await endedRuns('intact', reason);
    const gone = await endedRuns('gone', reason);
    const plain = await endedRuns('intact', 'upstream still down');
    const reasonOf = (stdout: string) => {
      const first = stdout.split('\n')[0] ?? '';
      return first.slice(first.indexOf(' Reason: ') + 1);
    };
    const a = read(intact.home, ['run', 'abandon', intact.ended]);
    const g = read(gone.home, ['run', 'abandon', gone.ended]);
    const p = read(plain.home, ['run', 'abandon', plain.ended]);
    const fixed = read(gone.home, ['run', 'abandon', gone.live]);
    // (a) red when abandon reads no manifest (the canary shows on the intact run), or prints the
    //     reason as text under withholding (it shows there); (b) prints the Reason: texts (fake
    //     words, a marker, a shape) and booleans.
    expect({
      intact: [reasonOf(a.stdout), a.stderr.includes('Values withheld')],
      gone: [
        reasonOf(g.stdout),
        g.stderr.includes(
          `Run realm run inspect ${gone.ended} --accept-partial-disclosure to print them`,
        ),
      ],
      plain: [reasonOf(p.stdout), p.stderr.includes('Values withheld')],
      fixed: [reasonOf(fixed.stdout), fixed.stderr.includes('Values withheld')],
    }).toEqual({
      intact: ['Reason: upstream refused key [REDACTED].', false],
      gone: [`Reason: ‹string, ${reason.length} characters›.`, true],
      plain: ['Reason: upstream still down.', false],
      fixed: ['Reason: Abandoned via realm run abandon.', false],
    });
  }, 120_000);

  it("I-11: `realm agent --run-id` reads an ended run's manifest before its refusal — the reason masked; its shape and the line while withheld", async () => {
    const reason = `upstream refused key ${SECRET}`;
    const intact = await endedRuns('intact', reason);
    const gone = await endedRuns('gone', reason);
    const plain = await endedRuns('intact', 'upstream still down');
    const agent = (home: string, runId: string) =>
      piped(['agent', '--run-id', runId, '--model', 'anthropic:fake-model-0729'], {
        HOME: home,
        REALM_NOT_SECRET: 'HOME',
        ANTHROPIC_API_KEY: 'fake-key-0729',
      });
    const reasonOf = (stderr: string) => stderr.split('\n').find((l) => l.startsWith('Reason:'));
    const a = agent(intact.home, intact.ended);
    const g = agent(gone.home, gone.ended);
    const p = agent(plain.home, plain.ended);
    // (a) red when the agent reads no manifest before the refusal (the canary shows on the intact
    //     run), or the refusal prints the reason as text under withholding; (b) prints the exit
    //     codes, the Reason: lines (fake words, a marker, a shape) and booleans.
    expect({
      intact: [a.status, reasonOf(a.stderr), a.stderr.includes('Values withheld')],
      gone: [
        g.status,
        reasonOf(g.stderr),
        g.stderr.includes(
          `Run realm run inspect ${gone.ended} --accept-partial-disclosure to print them`,
        ),
      ],
      plain: [p.status, reasonOf(p.stderr), p.stderr.includes('Values withheld')],
    }).toEqual({
      intact: [1, 'Reason: "upstream refused key [REDACTED]"', false],
      gone: [1, `Reason: ‹string, ${reason.length} characters›`, true],
      plain: [1, 'Reason: "upstream still down"', false],
    });
  }, 120_000);
});

describe('#729 PR-3 correction 5 (J-1) — an unclosed quote in a stored reason hides to its line end, never past it', () => {
  it("round 5 W2's shape: `--reason 'password=\" FAKE…'` — piped inspect's `Cause:` hidden on its line, every line after it and the receipt intact", async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(
      definitionAt(undefined),
    );
    const runId = (
      await new JsonFileStore(join(home, '.realm', 'runs')).create({
        workflowId: 'records-729',
        workflowVersion: 1,
        params: {},
      })
    ).run.id;
    piped(['run', 'abandon', runId, '--reason', 'password=" FAKEj10'], { HOME: home });
    const lines = piped(['run', 'inspect', runId], { HOME: home }).stdout.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Cause:'));
    // (a) red when the level-0 scan runs past the line (the following lines and the receipt are
    //     hidden — `Disclosure:` glued to `Cause:`), or the value shows; (b) prints the line labels
    //     from `Cause:` on (the canary is fake), and whether the receipt line stands alone.
    expect({
      cause: lines[at],
      after: lines.slice(at + 1).map((l) => l.split(':')[0]),
      receipt: lines.some((l) => l.startsWith('Disclosure: declared values')),
    }).toEqual({
      cause: 'Cause: password=" [REDACTED]',
      after: [
        'Completed',
        'In Progress',
        'Failed',
        'Skipped',
        'Created',
        'Updated',
        '',
        'Evidence (0 steps)',
        'Disclosure',
        '',
      ],
      receipt: true,
    });
  }, 60_000);
});

describe("#729 PR-3 correction 5 (J-6) — diff's hash columns take the longer of the hex and the shape", () => {
  it('a run whose output the law hid inside beside a clean run: every row and the header start the B hash and Δ ms columns at the same place', async () => {
    const { home, ids } = await diffRuns3(SECRET);
    // A clean run in the same store: its output holds nothing the law hides.
    const definition = definitionAt(join(root, `project-diff-${SECRET.length}`), {
      id: 'diff-729',
    });
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const dirty = await store.get(ids.a);
    const { run: created } = await store.create({
      workflowId: 'diff-729',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: created.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({ note: 'FAKEplain0729c5' }),
    });
    await store.update({
      ...(await store.get(created.id)),
      extension_identity: dirty.extension_identity,
    } as RunRecord);
    const lines = piped(['run', 'diff', ids.a, created.id], {
      HOME: home,
      REALM_NOT_SECRET: 'HOME',
    }).stdout.split('\n');
    const header = lines.find((l) => l.startsWith('Step')) ?? '';
    const row = lines.find((l) => l.startsWith('a ')) ?? '';
    const cleanHash = (await store.get(created.id)).evidence[0]!.evidence_hash.slice(0, 8);
    // (a) red when the hash columns keep a fixed width (the shaped cell pushes `B hash` and `Δ ms`
    //     right of the header's); (b) prints the header's and the row's column starts (numbers) and
    //     whether the row holds a shape.
    expect({
      shaped: row.includes('‹string, 8 characters›'),
      bHash: [header.indexOf('B hash'), row.indexOf(cleanHash)],
      deltaMs: [header.indexOf('Δ ms'), row.length - (row.split(' ').at(-1) ?? '').length],
    }).toEqual({
      shaped: true,
      // The shape is 22 characters, so each hash column is 24 wide: `Step` 22 + 1, `A status`
      // 12 + 1, `B status` 10 + 1, then `A hash` at 47, `B hash` at 72, `Δ ms` at 97.
      bHash: [72, 72],
      deltaMs: [97, 97],
    });
  }, 120_000);
});
