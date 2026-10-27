// #729 PR-3 (prompt 05 "Docs claims"; guardrail 9): each docs sentence the disclosure change adds or
// changes is quoted here exactly, asserted to still be on its page (read from the repository), and
// executed: the case it states is driven through the code and its result asserted. Neither the page
// nor the behaviour can change alone. Every value is fake. Each assertion names (a) the change that
// turns it red and (b) what it prints: booleans, counts, codes, fake text — never a value from
// outside this file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  buildDisclosureSet,
  disclose,
  discloseGate,
  discloseRecord,
  environmentEntries,
  executeChain,
  manifestSecretsBlockHash,
  DEPLOYMENT_MANIFEST_JSON_SCHEMA,
  inboundMarkerWarning,
  notSecretIntersection,
  REALM_CREDENTIAL_VARIABLES,
  REALM_SETTING_VARIABLES,
  shapeOf,
  tierFor,
  validateDeploymentManifest,
  type DisclosureAudience,
  type DisclosureReceipt,
  type PendingGate,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { abandonCommand } from './abandon.js';
import { agentCommand, buildReattachFlags } from './agent.js';
import { buildExportBundle, exportDisclosureLine, exportDisclosureRefusal } from './export.js';
import { diffRuns } from './diff.js';
import {
  addDeclaredValues,
  installWriter,
  writerModeOf,
  writerTestSeams,
} from '../output/writer.js';
import { sanitizeError } from '../agent/providers/agent-utils.js';
import { load as loadYaml } from 'js-yaml';
import { inspectReceiptLine, inspectRun } from './inspect.js';
import { PROOF_ABSENT_WORDS, PROOF_WORDS } from '../lib/holder-render.js';
import { QUESTION_DECLARED_ONLY_WORDS, declaredWords } from '../output/writer.js';
import { readRunManifest } from '../lib/read-run-manifest.js';
import {
  clearProjectExtensionsCache,
  loadProjectExtensions,
} from '../extensions/load-project-extensions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const CLI_ENTRY = join(HERE, '..', '..', 'dist', 'index.js');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)).includes(flat(sentence)), `${page} no longer says: ${sentence}`).toBe(
    true,
  );
}

const ENV_PAGE = 'docs/reference/environment-and-files.md';
const MANIFEST_PAGE = 'docs/reference/deployment-manifest.md';
const RECORD_PAGE = 'docs/reference/run-record-and-export.md';
const READING_PAGE = 'docs/reference/cli/realm-run-reading.md';
const ACTING_PAGE = 'docs/reference/cli/realm-run-acting.md';
const WORKFLOW_PAGE = 'docs/reference/cli/realm-workflow.md';
const AGENT_PAGE = 'docs/reference/cli/realm-agent.md';
const OPERATE_PAGE = 'docs/guides/operate-runs.md';
const TOOLS_PAGE = 'docs/guides/agent-tools.md';

// Fake values, each 8+ characters unless named otherwise.
const DECLARED = 'FAKE-DECLARED-0729';
const ENV_VALUE = 'FAKE-ENV-VALUE-0729';
const ENV_SEVEN = 'FAKE-07';
const FAKE_HOME = '/home/fake-user-0729';
const FAKE_USER = 'fake-user-0729';

/** A set for `audience` over a fixed fake environment, `declared` and `extra` env entries. */
function setFor(
  audience: DisclosureAudience,
  extra: Record<string, string> = {},
  notSecret?: string[],
  declared: Record<string, string> = { S: DECLARED },
  cwd?: string,
) {
  return buildDisclosureSet({
    env: {
      HOME: FAKE_HOME,
      USER: FAKE_USER,
      SVC_VALUE: ENV_VALUE,
      SVC_SEVEN: ENV_SEVEN,
      ...extra,
    },
    declared,
    declaredState: 'resolved',
    audience,
    ...(notSecret !== undefined ? { notSecret } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  }).set;
}

/** What `audience` is shown of `text`. */
const shown = (text: string, audience: DisclosureAudience, set = setFor(audience)): string =>
  disclose(text, set, tierFor(audience)).text;

describe(`${ENV_PAGE} — REALM_NOT_SECRET`, () => {
  it('the count of the variables Realm reads by name matches its table, and its REALM_ names are the ones the code reads', () => {
    claim(ENV_PAGE, "Realm's own code reads 11 variables by name:");
    const lines = read(ENV_PAGE).split('\n');
    const start = lines.findIndex((l) =>
      l.includes("Realm's own code reads 11 variables by name:"),
    );
    let rows = 0;
    const names: string[] = [];
    let i = start + 1;
    while (i < lines.length && !lines[i]!.startsWith('|')) i++;
    for (i += 2; i < lines.length && lines[i]!.startsWith('| `'); i++) {
      rows++;
      names.push(lines[i]!.split('`')[1]!);
    }
    // (a) red when a row is added or removed without the count, or the table's REALM_ names part
    //     from the variables realm's code reads (core's two lists and REALM_NOT_SECRET); (b) prints
    //     the row count and the names.
    expect({
      rows,
      realm: names.filter((n) => n.startsWith('REALM_')).sort(),
    }).toEqual({
      rows: 11,
      realm: [...REALM_SETTING_VARIABLES, ...REALM_CREDENTIAL_VARIABLES, 'REALM_NOT_SECRET'].sort(),
    });
  });

  it("realm's own settings, and the shell's PWD, OLDPWD and _, are not treated as secrets; REALM_SERVE_TOKEN is (D-14, D-6)", () => {
    claim(
      ENV_PAGE,
      "Realm's own settings in this table (`REALM_DEV`, `REALM_NO_NUDGE`, `REALM_REQUIRE_WRITER_NONCE`, `REALM_OPERATOR`, `REALM_MCP_GATE_ANSWERS` and `REALM_MCP_FORM_WAIT_SECONDS`) are not treated as secrets, and neither are `PWD`, `OLDPWD` and `_`, which the shell sets to paths; `REALM_SERVE_TOKEN`, a credential, is.",
    );
    const env = {
      REALM_OPERATOR: 'fake-operator-0729',
      REALM_MCP_GATE_ANSWERS: 'withheld',
      REALM_SERVE_TOKEN: 'FAKEservetoken0729',
      PWD: '/srv/fake-work-0729',
      OLDPWD: '/srv/fake-old-0729',
      _: '/usr/bin/fake-cmd-0729',
    };
    // (a) red when a setting or a shell path is hidden, or the serve token shows; (b) prints the
    //     variable names that are members (names only).
    expect(
      ['log', 'agent'].map((audience) =>
        environmentEntries(env, { audience: audience as DisclosureAudience }).map((e) => e.source),
      ),
    ).toEqual([['env:REALM_SERVE_TOKEN'], ['env:REALM_SERVE_TOKEN']]);
  });

  it('a value another variable holds is still hidden; a path under the home folder is hidden in a log, except inside a printed command (correction 2, R31)', async () => {
    claim(ENV_PAGE, 'A value that another, unlisted variable also holds is still hidden.');
    claim(
      ENV_PAGE,
      'A path under your home folder is hidden in a log, except inside a command Realm prints, which it shows whole.',
    );
    const set = buildDisclosureSet({
      env: { REALM_OPERATOR: 'fake-operator-0729', OTHER_X: 'fake-operator-0729' },
      declared: {},
      declaredState: 'resolved',
      audience: 'log',
    }).set;
    // The home folder rule, executed: a damaged copy under HOME, inspected piped.
    const home = mkdtempSync(join(tmpdir(), 'realm-docs-c2-home-'));
    try {
      const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
      await workflows.register({
        id: 'blockedwf',
        name: 'b',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
      } as WorkflowDefinition);
      const file = join(home, '.realm', 'workflows', 'blockedwf.json');
      writeFileSync(file, 'not json');
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const runId = (await runs.create({ workflowId: 'blockedwf', workflowVersion: 1, params: {} }))
        .run.id;
      // A path under HOME in the run's reason, printed as text.
      const { abandonRun } = await import('@sensigo/realm');
      await abandonRun(runs, runId, `stopped: ${home}/data is gone`);
      // Correction 3 (H-7''): the damaged copy's run reads `load_failed`, which withholds its
      // values; the flag prints them at the log's tier, where the home folder rule applies.
      const r = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'run', 'inspect', runId, '--accept-partial-disclosure'],
        {
          cwd: home,
          env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      // (a) red when a setting's value is shown while another variable holds it, a path under HOME
      //     shows in a log outside a command, or the printed command's path is hidden; (b) prints
      //     three booleans.
      expect({
        shadowHidden: disclose('operator fake-operator-0729', set, 'all').text.includes(
          '[REDACTED]',
        ),
        homeHidden: r.stdout.includes('[REDACTED]/data') && !r.stdout.includes(`${home}/data`),
        commandWhole: r.stdout.includes(`rm ${file}`),
      }).toEqual({ shadowHidden: true, homeHidden: true, commandWhole: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('every other environment value of 8 or more characters is hidden from an agent, a log, a broadcast and an export; a terminal hides only the declared secrets', () => {
    claim(
      ENV_PAGE,
      'Every other environment value of 8 or more characters is replaced with `[REDACTED]` in what an agent, a log, a broadcast (`realm listen`, `realm agent --log-mode`, Slack) or `realm run export` is shown; your own terminal hides only the secrets a deployment manifest declares.',
    );
    const text = `a ${ENV_VALUE} b ${ENV_SEVEN} c ${DECLARED}`;
    const per = (audience: DisclosureAudience) => {
      const t = shown(text, audience);
      return [t.includes(ENV_VALUE), t.includes(ENV_SEVEN), t.includes(DECLARED)];
    };
    // (a) red when an audience stops sweeping the environment, the floor moves off 8, or the
    //     terminal sweeps it; (b) prints [env shown, 7-char shown, declared shown] per audience.
    expect({
      agent: per('agent'),
      log: per('log'),
      broadcast: per('broadcast'),
      file: per('file'),
      terminal: per('private'),
    }).toEqual({
      agent: [false, true, false],
      log: [false, true, false],
      broadcast: [false, true, false],
      file: [false, true, false],
      terminal: [true, true, false],
    });
  });

  it("a listed name's value is shown, and still hidden while an unlisted variable holds it; a manifest's list names more", () => {
    claim(
      ENV_PAGE,
      "A listed name's value is still hidden while another, unlisted variable holds the same value. A manifest's `disclosure.not_secret` names more.",
    );
    const listed = 'FAKE-LISTED-0729';
    const alone = 'FAKE-ALONE-0729';
    const manifestNamed = 'FAKE-MANIFEST-0729';
    const set = setFor(
      'log',
      {
        REALM_NOT_SECRET: 'LISTED,ALONE',
        LISTED: listed,
        TWIN: listed,
        ALONE: alone,
        IN_MANIFEST: manifestNamed,
      },
      ['IN_MANIFEST'],
    );
    const t = shown(`${listed} ${alone} ${manifestNamed}`, 'log', set);
    // (a) red when REALM_NOT_SECRET is not read, a twin no longer keeps a listed value hidden, or the
    //     manifest's names are dropped; (b) prints three booleans.
    expect({
      twinStillHidden: !t.includes(listed),
      aloneShown: t.includes(alone),
      manifestNamedShown: t.includes(manifestNamed),
    }).toEqual({ twinStillHidden: true, aloneShown: true, manifestNamedShown: true });
  });
});

describe(`${MANIFEST_PAGE} — the disclosure block`, () => {
  it('its one key, its refusal, and a name counts when every loaded manifest lists it', () => {
    claim(
      MANIFEST_PAGE,
      '`disclosure` has one key, `not_secret`: the names of environment variables whose values Realm shows.',
    );
    claim(
      MANIFEST_PAGE,
      'A name counts when every manifest a program has loaded lists it, and only while no other variable that is not listed holds the same value.',
    );
    claim(MANIFEST_PAGE, "| Has another key | `manifest/disclosure: unknown key 'show'` |");
    // (a) red when the key's schema or its message changes, the example stops validating, or the
    //     lists are unioned instead of intersected; (b) prints the messages and the names.
    expect({
      example: validateDeploymentManifest({
        version: 1,
        disclosure: { not_secret: ['APP_REGION', 'LOG_LEVEL'] },
      }),
      another: validateDeploymentManifest({ version: 1, disclosure: { show: ['X'] } }),
      both: notSecretIntersection([['APP_REGION', 'LOG_LEVEL'], ['APP_REGION']]),
      none: notSecretIntersection([]),
    }).toEqual({
      example: [],
      another: ["manifest/disclosure: unknown key 'show'"],
      both: ['APP_REGION'],
      none: [],
    });
  });
});

describe(`${RECORD_PAGE} — the export file and the guard's conditions`, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-docs-729-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function bundleOf(params: Record<string, unknown>, audience: DisclosureAudience = 'file') {
    const store = new JsonFileStore(join(dir, 'runs'));
    const { run } = await store.create({ workflowId: 'docs-729', workflowVersion: 1, params });
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      setFor(audience),
    );
    return bundle;
  }

  it('10 fields; masked as an export is shown; home folder and user name shown; the receipt counts', async () => {
    claim(RECORD_PAGE, '`realm run export` writes a file with 10 fields:');
    claim(
      RECORD_PAGE,
      'the values of the environment `realm run export` runs in (8 or more characters; your home folder and user name are shown)',
    );
    claim(
      RECORD_PAGE,
      "`unmaskable` counts the declared secrets too short to hide (under 4 characters), `too_deep` counts the values written as their type and size because they lie more than 64 levels deep, `question: declared_only` is there when the file holds a gate's question (it hides only the declared secrets), `unchecked` is always `0` in this version, and `shaped`, when the file shows a value as its type and size, lists where each one is.",
    );
    claim(
      RECORD_PAGE,
      "the value after a credential's name, a token after `Bearer ` or `Basic `, and the text after `token=` replaced with `[REDACTED]`.",
    );
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 70; i++) deep = { d: deep };
    const deepBundle = await bundleOf({
      deep,
      prose: 'Bearer of the news',
      auth: 'Bearer FAKEtok9abc',
    });
    const asking = new JsonFileStore(join(dir, 'runs'));
    const { run: open } = await asking.create({
      workflowId: 'docs-729',
      workflowVersion: 1,
      params: {},
    });
    await asking.update({
      ...open,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'review',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-10-17T00:00:00.000Z',
        resolved_message: 'Ship it?',
      },
    } as RunRecord);
    const { bundle: questionBundle } = await buildExportBundle(
      open.id,
      {
        runStore: asking,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      setFor('file'),
    );
    const bundle = await bundleOf({
      env: ENV_VALUE,
      declared: DECLARED,
      home: `${FAKE_HOME}/notes`,
      user: FAKE_USER,
    });
    const short = buildDisclosureSet({
      env: {},
      declared: { S: 'abc' },
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    // (a) red when a field is added or dropped, an export stops masking, the file audience starts
    //     hiding the home folder, or the receipt's counts change meaning; (b) prints the count, the
    //     shown params (fake), and the counts.
    expect({
      fields: Object.keys(bundle).length,
      params: bundle.run.params,
      hidden: [bundle.disclosure.hidden.declared, bundle.disclosure.hidden.environment],
      unchecked: bundle.disclosure.unchecked,
      unmaskableShort: short.unmaskable,
      tooDeep: [bundle.disclosure.too_deep, deepBundle.disclosure.too_deep],
      question: [bundle.disclosure.question, questionBundle.disclosure.question],
      // #729 PR-3 correction 5 (J-6): `shaped` names where a value is shown as its type and size.
      shaped: [bundle.disclosure.shaped, deepBundle.disclosure.shaped],
      anchors: [deepBundle.run.params['prose'], deepBundle.run.params['auth']],
    }).toEqual({
      fields: 10,
      params: {
        env: '[REDACTED]',
        declared: '[REDACTED]',
        home: `${FAKE_HOME}/notes`,
        user: FAKE_USER,
      },
      hidden: [1, 1],
      unchecked: 0,
      unmaskableShort: 1,
      tooDeep: [0, 1],
      question: [undefined, 'declared_only'],
      // The subtree past 64 levels: `run.params.deep` and 62 more `.d`.
      shaped: [undefined, [`run.params.deep${'.d'.repeat(62)}`]],
      anchors: ['Bearer of the news', 'Bearer [REDACTED]'],
    });
  });

  it("the example's header line and its disclosure block are what the code writes", async () => {
    claim(
      RECORD_PAGE,
      'masked in the file: declared secrets unknown (load failed); environment swept; hidden 0 declared, 1 environment, 0 by pattern; 0 too short to hide; written on --accept-partial-disclosure (refused without it)',
    );
    const receipt = (over: Partial<DisclosureReceipt>): DisclosureReceipt => ({
      declared: 'resolved',
      environment: 'swept',
      hidden: { declared: 0, environment: 0, pattern: 0 },
      unchecked: 0,
      unmaskable: 0,
      too_deep: 0,
      ...over,
    });
    const page = read(RECORD_PAGE);
    const example = page.slice(page.indexOf('## An example'));
    const open = example.indexOf('```json\n') + '```json\n'.length;
    const json = JSON.parse(example.slice(open, example.indexOf('\n```', open))) as {
      realm_export_version: number;
      disclosure: DisclosureReceipt;
    };
    const bundle = await bundleOf({});
    // (a) red when the header's words change, the example's last clause parts from what the flag
    //     writes for a refused state (#886 correction), or the example's version or receipt keys
    //     part from what export writes; (b) prints the line, the version and the key lists.
    expect({
      header: exportDisclosureLine(
        receipt({
          declared: 'unknown',
          declared_cause: 'load_failed',
          hidden: { declared: 0, environment: 1, pattern: 0 },
        }),
        // #886 correction (K1): `unknown (load failed)` is refused, so it is only ever written on
        // `--accept-partial-disclosure`; the action then passes `true`
        true,
      ),
      version: json.realm_export_version,
      keys: Object.keys(json.disclosure),
    }).toEqual({
      header:
        'masked in the file: declared secrets unknown (load failed); environment swept; hidden 0 declared, 1 environment, 0 by pattern; 0 too short to hide; written on --accept-partial-disclosure (refused without it)',
      version: bundle.realm_export_version,
      keys: Object.keys(bundle.disclosure),
    });
  });

  it("a guard's conditions are in its diagnostics; an entry written the old way hashes differently and diffs as changed", async () => {
    claim(
      RECORD_PAGE,
      "The conditions it checked are in its `diagnostics.guard_conditions`. An entry written by version 0.47.1 or earlier holds them in `output_summary.conditions`, so a guard step's `evidence_hash` differs between the two, and `realm run diff` shows the step as changed.",
    );
    claim(
      RECORD_PAGE,
      "On a guard's entry: each of its `abort_unless` conditions with the value it found and whether it passed.",
    );
    const def: WorkflowDefinition = {
      id: 'guard-docs-729',
      name: 'g',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        g: {
          description: 'G.',
          execution: 'guard',
          depends_on: ['a'],
          abort_unless: ["a.text == 'ok'"],
        },
      },
    } as WorkflowDefinition;
    const store = new JsonFileStore(join(dir, 'runs'));
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({ text: 'ok' }),
    });
    const now = await store.get(run.id);
    const guard = now.evidence.find((e) => e.step_id === 'g')!;
    const oldOutput = { ...guard.output_summary, conditions: guard.diagnostics?.guard_conditions };
    const old: RunRecord = {
      ...now,
      evidence: now.evidence.map((e) =>
        e.step_id === 'g'
          ? {
              ...e,
              output_summary: oldOutput,
              evidence_hash: createHash('sha256').update(JSON.stringify(oldOutput)).digest('hex'),
            }
          : e,
      ),
    };
    const row = diffRuns(old, now).find((r) => r.step_id === 'g');
    // (a) red when the conditions return to the output, leave the diagnostics, or the diff stops
    //     comparing the hash; (b) prints the condition count, a key list and two booleans.
    expect({
      conditions: guard.diagnostics?.guard_conditions?.length,
      outputKeys: Object.keys(guard.output_summary),
      sameHash: row?.same_output,
      present: row !== undefined,
    }).toEqual({ conditions: 1, outputKeys: ['aborted'], sameHash: false, present: true });
  });
});

describe(`${READING_PAGE} — export`, () => {
  it('the third line, the refusal per state, and its start and end', () => {
    claim(
      READING_PAGE,
      'masked in the file: declared secrets resolved; environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 too short to hide',
    );
    // #879 (C2): the page's first and third sentences of the export paragraph
    claim(
      READING_PAGE,
      'The third line is about the file: what its masking knew, how many values it hid, by kind, and how many declared secrets are too short to hide (under 4 characters).',
    );
    claim(
      READING_PAGE,
      "When the file holds a gate's question, the third line says `question: declared tier only`: a question hides only the declared secrets.",
    );
    claim(
      READING_PAGE,
      "Writes the file even when Realm does not know all of the run's declared secrets. It is masked with what is known, and the last line names the state.",
    );
    const line = (over: Partial<DisclosureReceipt>) =>
      exportDisclosureLine({
        declared: 'resolved',
        environment: 'swept',
        hidden: { declared: 0, environment: 0, pattern: 0 },
        unchecked: 0,
        unmaskable: 0,
        too_deep: 0,
        ...over,
      });
    // (a) red when the third line's words, its too-short count or its question clause change; (b)
    //     prints the lines.
    expect([line({}), line({ unmaskable: 2, question: 'declared_only' })]).toEqual([
      'masked in the file: declared secrets resolved; environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 too short to hide',
      'masked in the file: declared secrets resolved; environment swept; hidden 0 declared, 0 environment, 0 by pattern; 2 too short to hide; question: declared tier only',
    ]);
    const start =
      "Refusing to export run '<run-id>': Realm does not know all of its declared secrets";
    const end =
      'A bundle written now could hold a secret the masking cannot recognise. Restore the manifest the run used, or pass --accept-partial-disclosure to write it masked with what is known; the last line it prints then names the state.';
    const noProjectEnd =
      'The run has no manifest to restore, so pass --accept-partial-disclosure to write it masked with what is known; the last line it prints then names the state.';
    claim(READING_PAGE, `Each starts \`${start}\` and ends \`${end}\``);
    claim(READING_PAGE, `For a run with no project, the end reads \`${noProjectEnd}\``);
    const rows = {
      manifest_changed: '— its deployment manifest changed since the run recorded it, or is gone.',
      load_failed: '— its deployment manifest or a secret it names could not be read (<why>).',
      no_manifest: '— the run has no project (its workflow copy records no deployment root).',
    } as const;
    for (const ending of Object.values(rows)) claim(READING_PAGE, `\`${ending} …\``);
    const refusal = (cause: keyof typeof rows) =>
      exportDisclosureRefusal('<run-id>', {
        declaredState: cause === 'manifest_changed' ? 'partial' : 'unknown',
        declaredCause: cause,
        declared: {},
        ...(cause === 'load_failed' ? { detail: '<why>' } : {}),
      } as Parameters<typeof exportDisclosureRefusal>[1])!;
    // (a) red when a refusal's words change; (b) prints, per cause, three booleans.
    expect(
      Object.fromEntries(
        (Object.keys(rows) as (keyof typeof rows)[]).map((c) => [
          c,
          [
            refusal(c).startsWith(start),
            refusal(c).includes(rows[c]),
            refusal(c).endsWith(c === 'no_manifest' ? noProjectEnd : end),
          ],
        ]),
      ),
    ).toEqual({
      manifest_changed: [true, true, true],
      load_failed: [true, true, true],
      no_manifest: [true, true, true],
    });
    // (a) red when the resolved state is refused; (b) prints a boolean.
    expect(
      exportDisclosureRefusal('r', { declaredState: 'resolved', declared: {} }) === undefined,
    ).toBe(true);
  });

  it('the command exits 1 on a refusal, writing nothing', async () => {
    claim(
      READING_PAGE,
      "1 if the run is not in the store, if the file exists, if Realm does not know all of the run's declared secrets and `--accept-partial-disclosure` was not given,",
    );
    const root = mkdtempSync(join(tmpdir(), 'realm-docs-export-729-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      // A run whose workflow copy cannot be read: its declared secrets are unknown.
      const { run } = await new JsonFileStore(join(home, '.realm', 'runs')).create({
        workflowId: 'not-registered',
        workflowVersion: 1,
        params: {},
      });
      const r = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'run', 'export', run.id, '--out', join(root, 'x.json')],
        {
          cwd: root,
          env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NOT_SECRET: 'HOME' },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      // (a) red when the refusal stops exiting 1 or a file is written; (b) prints the code and two
      //     booleans.
      expect({
        code: r.status,
        starts: r.stderr.startsWith(`Refusing to export run '${run.id}'`),
        written: existsSync(join(root, 'x.json')),
      }).toEqual({ code: 1, starts: true, written: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe(`${ACTING_PAGE} and ${WORKFLOW_PAGE} — the rerun, --params-from-run, the marker warning`, () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logged: string[];
  let warned: string[];
  let errored: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-docs-home-729-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-docs-wf-729-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    writeFileSync(
      join(dir, 'workflow.yaml'),
      'id: pfr\nname: pfr\nversion: 1\nsteps:\n  a:\n    description: a\n    execution: agent\n',
      'utf8',
    );
    logged = [];
    warned = [];
    errored = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  async function registeredRun(params: Record<string, unknown>): Promise<string> {
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
      id: 'pfr',
      name: 'pfr',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
      source_dir: dir,
    } as WorkflowDefinition);
    const { run } = await new JsonFileStore(join(home, '.realm', 'runs')).create({
      workflowId: 'pfr',
      workflowVersion: 1,
      params,
    });
    return run.id;
  }

  it("abandon's rerun lines are the page's: the command alone on its line, the run's params not printed (correction 2)", async () => {
    const docId = '00b33778-f504-4d65-93ca-6300441f41e7';
    const docLines = [
      'To run the same work again, start a fresh run:',
      `  realm workflow run /srv/shop/sync --params-from-run ${docId}`,
      `  That is the directory it was registered from. This run's evidence stays at realm run inspect ${docId}.`,
    ];
    for (const l of docLines) claim(ACTING_PAGE, l);
    claim(
      ACTING_PAGE,
      "The third line, a line of its own so it copies cleanly, is a command that starts a new run of the same workflow with the same parameters, read from this run's record: the parameters themselves are not printed.",
    );
    const id = await registeredRun({ fail: 'FAKE-PARAM-0729' });
    await abandonCommand.parseAsync([id], { from: 'user' });
    const out = logged.join('\n').split('\n');
    const at = out.findIndex((l) => l === docLines[0]);
    const lines = at === -1 ? [] : out.slice(at, at + 3);
    // (a) red when the lines' words change, the command shares its line with its note, or it prints
    //     the params; (b) prints a boolean pair.
    expect({
      samePage:
        JSON.stringify(lines) ===
        JSON.stringify(docLines.map((l) => l.replace('/srv/shop/sync', dir).replaceAll(docId, id))),
      valueShown: lines.some((l) => l.includes('FAKE-PARAM-0729')),
    }).toEqual({ samePage: true, valueShown: false });
  });

  it("--params-from-run: the two refusals are the page's", async () => {
    claim(
      WORKFLOW_PAGE,
      "Starts with the parameters of an earlier run of this workflow, read from that run's record as they were given, not as any output showed them. Cannot be given with `--params`.",
    );
    const both = 'Error: give --params or --params-from-run, not both.';
    const other =
      "Error: run '<run-id>' is a run of workflow '<other>', not '<this>'; its params are not this workflow's.";
    claim(
      WORKFLOW_PAGE,
      `\`--params-from-run\` refuses a run of another workflow (\`${other}\`) and refuses to be given with \`--params\` (\`${both}\`).`,
    );
    const id = await registeredRun({});
    const another = await new JsonFileStore(join(home, '.realm', 'runs')).create({
      workflowId: 'another',
      workflowVersion: 1,
      params: {},
    });
    const attempt = (args: string[]) =>
      runCommand.parseAsync([dir, ...args], { from: 'user' }).catch(() => undefined);
    await attempt(['--params', '{"a":1}', '--params-from-run', id]);
    await attempt(['--params-from-run', another.run.id]);
    // The mocked exit throws inside the command's own catch, which prints one more line a real exit
    // never reaches (`…: process.exit`); it is left out.
    // (a) red when either refusal's words change; (b) prints the two messages (fake ids).
    expect(errored.filter((e) => !e.endsWith(': process.exit'))).toEqual([
      both,
      other
        .replace('<run-id>', another.run.id)
        .replace('<other>', 'another')
        .replace('<this>', 'pfr'),
    ]);
  });

  it("#729 PR-3 correction 4 (I-9b): `realm workflow run`'s step line shows the hash of an output the law hid anything inside as its type and size, at both of its sites", async () => {
    const PIN = 'FK42c4';
    const runOf = async (yaml: string, answer: string): Promise<string[]> => {
      writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
      logged.length = 0;
      mocks.question.mockImplementation(async () => answer);
      await runCommand.parseAsync([dir], { from: 'user' }).catch(() => undefined);
      return logged.filter((l) => l.includes('✓ → '));
    };
    const one =
      'id: c4one\nname: c4one\nversion: 1\nsteps:\n  a:\n    description: a\n    execution: agent\n';
    // The second site: the agent step completes, and its chain stops at a step this runner lacks.
    const chain =
      'id: c4chain\nname: c4chain\nversion: 1\nsteps:\n  a:\n    description: a\n    execution: agent\n  b:\n    description: b\n    execution: auto\n    depends_on: [a]\n    handler: missing_c4\n';
    installWriter('default');
    let lines: { hid: string[]; plain: string[]; chained: string[] };
    try {
      addDeclaredValues({ PIN });
      lines = {
        hid: await runOf(one, JSON.stringify({ pin: PIN })),
        plain: await runOf(one, JSON.stringify({ pin: 'open' })),
        chained: await runOf(chain, JSON.stringify({ pin: PIN })),
      };
    } finally {
      writerTestSeams.reset();
    }
    const runs = await new JsonFileStore(join(home, '.realm', 'runs')).list();
    const plainHash = runs
      .flatMap((r) => r.evidence)
      .find((e) => (e.output_summary as Record<string, unknown>)['pin'] === 'open')
      ?.evidence_hash.slice(0, 8);
    const hashOf = (l: string[]) => l.map((x) => x.match(/hash: (.*?)\.\.\./)?.[1]);
    // (a) red when either site prints the hex of an output the law hid inside, or shapes one it hid
    //     nothing inside; (b) prints the hash parts (shapes and the fake run's own hex).
    expect({
      hid: hashOf(lines.hid),
      plain: hashOf(lines.plain),
      chained: hashOf(lines.chained),
    }).toEqual({
      hid: ['‹string, 8 characters›'],
      plain: [plainHash],
      chained: ['‹string, 8 characters›'],
    });
  });

  it("an answer typed at a step's prompt that holds a marker: the same sentence, indented, without `Warning:` (correction 1)", async () => {
    claim(
      WORKFLOW_PAGE,
      "For an answer typed at a step's prompt, the same sentence is printed indented under the prompt, without `Warning:`.",
    );
    mocks.question.mockImplementation(async () => '{"k":"[REDACTED]"}');
    await runCommand.parseAsync([dir], { from: 'user' });
    const [run] = await new JsonFileStore(join(home, '.realm', 'runs')).list();
    // (a) red when the typed answer's warning gains `Warning:`, loses its indent or its words, or
    //     the answer is changed before it is recorded; (b) prints the warning (fixed) and a boolean.
    expect({
      warning: warned.find((w) => w.includes('This answer holds')),
      recordedAsGiven:
        run?.evidence.find((e) => e.step_id === 'a')?.output_summary['k'] === '[REDACTED]',
    }).toEqual({ warning: `  ${inboundMarkerWarning(['[REDACTED]'])}`, recordedAsGiven: true });
  });

  it('a marker sent back is recorded as given, with the warning the page quotes', async () => {
    const warning =
      "Warning: This answer holds '[REDACTED]': a value Realm hid when it showed it, sent back. Realm records what was sent, the marker included, so the run now holds the marker, not the value. Send the value itself, or leave the field out. An answer with no marker is recorded as sent.";
    claim(WORKFLOW_PAGE, `a warning says so: \`${warning}\``);
    claim(
      WORKFLOW_PAGE,
      "Parameters given with `--params`, and an answer typed at a step's prompt, are recorded as given.",
    );
    mocks.question.mockImplementation(async () => '{}');
    await runCommand.parseAsync([dir, '--params', '{"k":"[REDACTED]"}'], { from: 'user' });
    const [run] = await new JsonFileStore(join(home, '.realm', 'runs')).list();
    // (a) red when the warning's words change or the params are changed before they are recorded;
    //     (b) prints the warning text (fixed) and a boolean.
    expect({
      warning: warned.find((w) => w.startsWith('Warning: This answer holds')),
      same: `Warning: ${inboundMarkerWarning(['[REDACTED]'])}`,
      recordedAsGiven: run?.params['k'] === '[REDACTED]',
    }).toEqual({ warning, same: warning, recordedAsGiven: true });
  });
});

describe(`${AGENT_PAGE} — --log-mode`, () => {
  afterEach(() => {
    agentCommand.setOptionValue('logMode', undefined);
  });

  it('prints as a shared log; values as their type and size; not repeated by the re-attach command', () => {
    claim(
      AGENT_PAGE,
      "Prints as a shared log, as the drives `realm listen` starts do: a run's values print as their type and size (`‹string, 42 characters›`), and one `Disclosure:` line per run counts what was hidden.",
    );
    claim(AGENT_PAGE, 'The re-attach command does not repeat it.');
    const before = writerModeOf(agentCommand);
    agentCommand.parseOptions(['--log-mode']);
    // The one-line-per-run claim is executed by the source-canary suite's `realm agent` cell
    // (`receiptLines: 1`).
    // (a) red when --log-mode stops choosing the broadcast audience, the shape's words change, or
    //     the re-attach builder repeats the flag; (b) prints the modes, the shape and a boolean.
    expect({
      before,
      after: writerModeOf(agentCommand),
      shape: shapeOf('x'.repeat(42)),
      reattachRepeats: buildReattachFlags({
        provider: 'openai',
        model: 'm',
        logMode: true,
      } as Parameters<typeof buildReattachFlags>[0]).includes('--log-mode'),
    }).toEqual({
      before: 'default',
      after: 'broadcast',
      shape: '‹string, 42 characters›',
      reattachRepeats: false,
    });
  });
});

describe(`${OPERATE_PAGE} — what the output hides`, () => {
  const text = `d ${DECLARED} e ${ENV_VALUE} h ${FAKE_HOME}/x u ${FAKE_USER} p password=fakepw1`;
  const row = (audience: DisclosureAudience) => {
    const t = shown(text, audience);
    return {
      declared: !t.includes(DECLARED),
      environment: !t.includes(ENV_VALUE),
      home: !t.includes(FAKE_HOME),
      user: !t.includes(FAKE_USER),
      afterName: !t.includes('fakepw1'),
    };
  };
  const all = { declared: true, environment: true, home: true, user: true, afterName: true };

  it('per audience, what is hidden', () => {
    claim(OPERATE_PAGE, '| Your terminal | The secrets a deployment manifest declares. |');
    claim(
      OPERATE_PAGE,
      "| Output sent to a file or a pipe, such as a CI log | The declared secrets, every environment value of 8 or more characters (your home folder and user name included, when they are 8 or more characters long), and the value after a credential's name, such as `password=…`. |",
    );
    claim(
      OPERATE_PAGE,
      '| An agent: MCP replies, and what `realm agent` sends the model | The same as a log. |',
    );
    claim(
      OPERATE_PAGE,
      '| The file `realm run export` writes | The same as a log, except that your home folder and user name are shown. |',
    );
    // (a) red when an audience's tier or its home-folder rule changes; (b) prints, per audience,
    //     which kinds are hidden (booleans).
    expect({
      terminal: row('private'),
      log: row('log'),
      agent: row('agent'),
      broadcast: row('broadcast'),
      file: row('file'),
      // A user name under 8 characters is not hidden in a log.
      shortUserInLog: shown('by fu7', 'log', setFor('log', { USER: 'fu7' })),
    }).toEqual({
      terminal: { declared: true, environment: false, home: false, user: false, afterName: false },
      log: all,
      agent: all,
      broadcast: all,
      file: { ...all, home: false, user: false },
      shortUserInLog: 'by fu7',
    });
  });

  it("a broadcast prints a run's values as their type and size; a gate's question hides only the declared secrets, everywhere", () => {
    claim(
      OPERATE_PAGE,
      "| `realm listen`'s log, `realm agent --log-mode` and Slack | The same as a log. A run's values also print as their type and size, such as `‹string, 42 characters›`. |",
    );
    claim(OPERATE_PAGE, "A gate's question hides only the declared secrets, wherever it is shown.");
    const run = {
      id: 'r',
      params: { note: 'x'.repeat(42) },
      evidence: [],
    } as unknown as RunRecord;
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      preview: {},
      choices: ['approve'],
      opened_at: '2026-10-17T00:00:00.000Z',
      resolved_message: `Ship ${ENV_VALUE} with ${DECLARED}?`,
    };
    const audiences: DisclosureAudience[] = ['private', 'log', 'agent', 'broadcast', 'file'];
    // (a) red when broadcast stops shaping values, or a question gets another tier somewhere; (b)
    //     prints the shown params and, per audience, two booleans.
    expect({
      params: discloseRecord(run, setFor('broadcast'), 'broadcast').record.params,
      question: Object.fromEntries(
        audiences.map((a) => {
          const q = discloseGate(gate, setFor(a), a).resolved_message ?? '';
          return [a, [q.includes(ENV_VALUE), q.includes(DECLARED)]];
        }),
      ),
    }).toEqual({
      params: { note: '‹string, 42 characters›' },
      question: Object.fromEntries(audiences.map((a) => [a, [true, false]])),
    });
  });

  it("what a drive records, a log's line on an error, a pipe as a log, CI's workspace, an MCP client's environment, the program label (corrections 1 and 2)", async () => {
    claim(
      OPERATE_PAGE,
      "A run's file keeps every value as it was given, except what `realm agent` records of what it sent the model (its drive failures and its tools' errors), which is kept as the model saw it, and the error of a project that failed to load, which is masked where it is caught.",
    );
    claim(
      OPERATE_PAGE,
      'ends with one `Disclosure:` line that counts what was hidden and how many values were printed as their type and size, also when the drive ends in an error.',
    );
    claim(
      OPERATE_PAGE,
      "Output that is piped or redirected reads as a log, so to see the full values, run the command on a terminal. A variable whose value is the working folder is not treated as a secret: npm's `INIT_CWD` and `npm_config_local_prefix` under `npx`, and a CI runner's workspace variable (`GITHUB_WORKSPACE`, `CI_PROJECT_DIR`) when the job runs in that folder. A variable that names a different folder still is, so paths under it read `[REDACTED]/…` in the log, and in the export file when the folder is not under your home folder, until you name the variable in `REALM_NOT_SECRET`. The home folder stays hidden in a log, so a path under it reads `[REDACTED]/…` for the home folder's part only.",
    );
    claim(
      OPERATE_PAGE,
      "For a `realm mcp` that an MCP client starts, set `REALM_NOT_SECRET` in that client's settings for the server (its `env` block): the client starts the server with its own environment.",
    );
    // F2: the CHANGELOG's line, executed by the workspace runs below and by the six message sites
    // (`source-canary-729.test.ts`, "F2 — the project folder prints whole under npx").
    claim(
      'CHANGELOG.md',
      "Under `npx realm`, a log no longer hides the project folder: a variable whose value is the working directory (npm's `INIT_CWD` and `npm_config_local_prefix`, a CI runner's workspace variable) is not treated as a secret. The home folder stays hidden in a log.",
    );
    claim(
      OPERATE_PAGE,
      "The program label `user@host` that names who took a step is attribution, shown whole everywhere, as are a run's phase and the commands Realm prints; a secret whose value is your user name shows inside the label.",
    );
    const home = mkdtempSync(join(tmpdir(), 'realm-docs-729-or-'));
    try {
      // What `realm agent` stores of a tool's error or a drive failure is `sanitizeError`'s text.
      vi.stubEnv('REALM_NOT_SECRET', '');
      vi.stubEnv('DOCS_729_OR_ENV', ENV_VALUE);
      const stored = sanitizeError(new Error(`failed with ${ENV_VALUE}`));
      vi.unstubAllEnvs();
      const env = { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' };
      // A log-mode drive that errors.
      const drive = spawnSync(
        process.execPath,
        [
          CLI_ENTRY,
          'agent',
          '--run-id',
          'no-such-run-0729',
          '--provider',
          'anthropic',
          '--model',
          'm',
          '--log-mode',
        ],
        {
          cwd: home,
          env: { ...env, ANTHROPIC_API_KEY: 'fake-key-0000' },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      // A piped inspect, with a user name of 8 or more characters and a step's program label.
      const store = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await store.create({ workflowId: 'docs-or', workflowVersion: 1, params: {} });
      const labelled = {
        ...run,
        completed_steps: ['a'],
        evidence: [
          {
            step_id: 'a',
            started_at: '2024-01-01T00:00:00.000Z',
            completed_at: '2024-01-01T00:00:01.000Z',
            duration_ms: 1000,
            input_summary: {},
            output_summary: {},
            status: 'success',
            evidence_hash: 'h',
            driven_by: { by: 'fakeuser9x@box-0729', by_source: 'derived', channel: 'agent' },
          },
        ],
      } as unknown as RunRecord;
      await store.update(labelled);
      // A secret whose value is the user name: it shows inside the label (a fact), as the page says.
      const piped = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', run.id], {
        cwd: home,
        env: { ...env, USER: 'fakeuser9x', DB_PASSWORD: 'fakeuser9x' },
        encoding: 'utf8',
        timeout: 60_000,
      }).stdout;
      const labelSet = (audience: DisclosureAudience) =>
        buildDisclosureSet({
          env: { USER: 'fakeuser9x' },
          declared: {},
          declaredState: 'resolved',
          audience,
        }).set;
      const labelIn = (audience: DisclosureAudience) =>
        (
          discloseRecord(labelled, labelSet(audience), audience).record.evidence[0] as {
            driven_by?: { by?: string };
          }
        ).driven_by?.by;
      const { getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      vi.stubEnv('REALM_NOT_SECRET', 'SOME_NAME');
      const clientEnv = getDefaultEnvironment();
      vi.unstubAllEnvs();
      const WS = '/ci/work/fake-repo-0729';
      // (a) red when a drive's stored error keeps the value, an erroring drive drops its line, a
      //     pipe is not a log, the workspace shows or REALM_NOT_SECRET cannot show it, the SDK's
      //     client passes REALM_NOT_SECRET on, or the label's audiences change; (b) prints texts
      //     and booleans (fake values).
      expect({
        stored,
        errorLine: [
          drive.status,
          drive.stderr.split('\n').some((l) => l.startsWith('Disclosure:')),
        ],
        pipedIsLog: piped.includes('environment swept'),
        labelInLog: piped.includes('Taken by: fakeuser9x@box-0729 ('),
        labelInMcpAndExport: [labelIn('agent'), labelIn('file')],
        workspace: [
          shown(`${WS}/src`, 'log', setFor('log', { GITHUB_WORKSPACE: WS })),
          shown(
            `${WS}/src`,
            'log',
            setFor('log', { GITHUB_WORKSPACE: WS, REALM_NOT_SECRET: 'GITHUB_WORKSPACE' }),
          ),
          shown(`${WS}/src`, 'file', setFor('file', { GITHUB_WORKSPACE: WS })),
          shown(
            `${WS}/src`,
            'file',
            setFor('file', { GITHUB_WORKSPACE: WS, REALM_NOT_SECRET: 'GITHUB_WORKSPACE' }),
          ),
          // F2: the job runs IN the workspace — its variable holds the working folder, never a
          // secret, on a log and in the file; run elsewhere, it still names another folder.
          shown(
            `${WS}/src`,
            'log',
            setFor('log', { GITHUB_WORKSPACE: WS }, undefined, undefined, WS),
          ),
          shown(
            `${WS}/src`,
            'file',
            setFor('file', { GITHUB_WORKSPACE: WS }, undefined, undefined, WS),
          ),
          shown(
            `${WS}/src`,
            'log',
            setFor('log', { GITHUB_WORKSPACE: WS }, undefined, undefined, '/ci/other-folder'),
          ),
        ],
        clientPassesIt: 'REALM_NOT_SECRET' in clientEnv,
      }).toEqual({
        stored: 'failed with [REDACTED]',
        errorLine: [1, true],
        pipedIsLog: true,
        labelInLog: true,
        labelInMcpAndExport: ['fakeuser9x@box-0729', 'fakeuser9x@box-0729'],
        workspace: [
          '[REDACTED]/src',
          `${WS}/src`,
          '[REDACTED]/src',
          `${WS}/src`,
          `${WS}/src`,
          `${WS}/src`,
          '[REDACTED]/src',
        ],
        clientPassesIt: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe(`${TOOLS_PAGE} — names, anchors and the home folder`, () => {
  it('the value after a credential name, the anchors, a URL password, and the home folder whole', () => {
    claim(
      TOOLS_PAGE,
      'Whatever their length, it also hides the value written after a credential\'s name — such as `password=…`, `DB_PASSWORD=…`, `"client_secret": "…"`, `x-api-key: …` or `Authorization: Bearer …` (there, the scheme word and the credential) — a token after `Bearer ` or `Basic `, the text after `token=`, and the password in a URL written `scheme://user:password@host` (a password holding `/` or a `"` is not read).',
    );
    claim(
      TOOLS_PAGE,
      "`tokensecret`, `apitoken`, `secretkey`, `passphrase`, `pwd`, `secretkeybase`, `encryptionkey`, `masterkey` and `secrets`; so `token_count` and `max_tokens` are not names of credentials, and a name that is `PWD` alone, the shell's working folder, is not one when its value is a path (it starts with `/` or `~`). Your home folder, and every other environment value under it, is hidden whole; `PWD`, `OLDPWD` and `_`, which the shell sets to paths, are not counted, so a path in a working folder under your home folder reads `[REDACTED]/…`, with the home folder's part hidden.",
    );
    const set = setFor('agent', {
      PWD: `${FAKE_HOME}/project`,
      PROJECT_DIR: `${FAKE_HOME}/proj2`,
    });
    const t = (s: string) => disclose(s, set, 'all').text;
    // (a) red when a name, an anchor, the URL password or the home rule stops hiding, or an
    //     ordinary count's name starts to; (b) prints the shown fake texts.
    expect([
      t('password=p1'),
      t('DB_PASSWORD=p2'),
      t('{"client_secret": "p3"}'),
      t('x-api-key: p4'),
      t('Authorization: Bearer p5'),
      t('Bearer FAKEtok9abc and Basic dXNlcjpwYXNz and token=p8'),
      t('Bearer of the news, Basic usage'),
      t('https://u:p9@host.test/x'),
      t('token_count=5 max_tokens=6'),
      t('passphrase=n1 secret_key_base=n2 encryption_key=n3 master_key=n4 secrets=n5 db_pwd=n6'),
      t('PWD=/srv/x'),
      // Correction 2: `pwd` alone with a value that is not a path; a URL password with `/` or `"`.
      t('Pwd=FAKEodbc9x;'),
      t('https://u:pa/ss9@host.test/x https://u:pa"ss9@host.test/y'),
      t(`${FAKE_HOME}/proj2`),
      t(`${FAKE_HOME}/project/a`),
    ]).toEqual([
      'password=[REDACTED]',
      'DB_PASSWORD=[REDACTED]',
      '{"client_secret": "[REDACTED]"}',
      'x-api-key: [REDACTED]',
      'Authorization: [REDACTED]',
      'Bearer [REDACTED] and Basic [REDACTED] and token=[REDACTED]',
      'Bearer of the news, Basic usage',
      'https://u:[REDACTED]@host.test/x',
      'token_count=5 max_tokens=6',
      'passphrase=[REDACTED] secret_key_base=[REDACTED] encryption_key=[REDACTED] master_key=[REDACTED] secrets=[REDACTED] db_pwd=[REDACTED]',
      'PWD=/srv/x',
      'Pwd=[REDACTED];',
      'https://u:pa/ss9@host.test/x https://u:pa"ss9@host.test/y',
      '[REDACTED]',
      '[REDACTED]/project/a',
    ]);
  });
});

// ── #729 PR-3 correction 1: the pages' new and changed sentences ────────────────────────────────
const UPGRADE_PAGE = 'docs/guides/upgrade.md';

describe(`${READING_PAGE} — inspect's new lines (correction 1)`, () => {
  it("the claim-token words are the code's, every row (D-14)", () => {
    const words = [
      PROOF_WORDS.matched,
      PROOF_WORDS.absent,
      PROOF_WORDS.mismatch,
      PROOF_WORDS.unverifiable.no_claim,
      PROOF_WORDS.spent.answered,
      PROOF_ABSENT_WORDS.proof_not_recorded,
      PROOF_ABSENT_WORDS.proof_unreadable,
    ];
    // (a) red when a row's words part from the code's, or the code puts `token:` back; (b) the
    //     claim prints the row.
    for (const w of words) claim(READING_PAGE, `\`${w}\``);
    claim(READING_PAGE, '`— the claim has no token` / `— this store keeps no claims`');
    claim(READING_PAGE, '`— already settled by its expiry`');
    expect([
      PROOF_WORDS.unverifiable.claim_has_no_token.endsWith('— the claim has no token'),
      PROOF_WORDS.unverifiable.store_keeps_no_claims.endsWith('— this store keeps no claims'),
      PROOF_WORDS.spent.expired.endsWith('— already settled by its expiry'),
    ]).toEqual([true, true, true]);
  });

  it("a guard's conditions on its Diagnostics line, and the run's `Aborted at:` line (F28)", async () => {
    claim(
      READING_PAGE,
      "On a guard's entry, each of its conditions, whether it passed, and the value it read: ` | guard: a.ok == true → passed (true)` (added after version 0.47.1).",
    );
    claim(
      READING_PAGE,
      '| `Aborted at` | When a guard or a handler aborted the run | The step, and its message in quotes, such as `Aborted at: \'check\': "The ticket is not open."`. A message longer than 500 characters as written reads `‹N characters, not kept›`. Added after version 0.47.1. |',
    );
    const dir = mkdtempSync(join(tmpdir(), 'realm-docs-729-guard-'));
    try {
      const def = {
        id: 'docs-guard',
        name: 'g',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          a: { description: 'A.', execution: 'agent', depends_on: [] },
          check: {
            description: 'Check.',
            execution: 'guard',
            depends_on: ['a'],
            abort_unless: ['a.ok == true', 'a.n > 1'],
            abort_message: 'The ticket is not open.',
          },
        },
      } as WorkflowDefinition;
      const store = new JsonFileStore(join(dir, 'runs'));
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeChain(store, def, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({ ok: true, n: 0 }),
      });
      const workflowStore = {
        get: async () => def,
        list: async () => [def],
        register: async () => {},
      };
      const out = await inspectRun(run.id, store, workflowStore as never);
      const long = await (async () => {
        const record = await store.get(run.id);
        await store.update({
          ...record,
          aborted_at: { ...record.aborted_at!, abort_message: 'x'.repeat(600) },
        });
        return inspectRun(run.id, store, workflowStore as never);
      })();
      // (a) red when the guard part or the line is not printed, or a long message is cut instead of
      //     replaced whole; (b) prints booleans.
      expect({
        guard: out.includes(' | guard: a.ok == true → passed (true), a.n > 1 → failed (0)'),
        abortedAt: out.includes(`Aborted at: 'check': "The ticket is not open."`),
        long: long.includes("Aborted at: 'check': ‹602 characters, not kept›"),
      }).toEqual({ guard: true, abortedAt: true, long: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the `Disclosure:` line on a terminal and in a log, its declared words, its question clause (F13, F16)', () => {
    claim(
      READING_PAGE,
      "Disclosure: declared values resolved; environment values and values after a credential's name are shown on this terminal; hidden 1 declared: declared:SHOP_TOKEN; 0 not checked; 0 too short to hide.",
    );
    claim(
      READING_PAGE,
      'Disclosure: declared values resolved; environment swept; hidden 1 declared, 1 environment, 0 by pattern; 0 not checked; 0 too short to hide.',
    );
    claim(
      READING_PAGE,
      "`declared values` reads `resolved`, `resolved (no manifest)`, `partial (manifest changed)`, `unknown (load failed)` or `unknown (no manifest)`, as for [`export`](#export). When the record shows a gate's question, the line ends `; question: declared tier only`: a question hides only the declared secrets.",
    );
    const base = {
      declared: 'resolved' as const,
      hidden: { declared: 1, environment: 0, pattern: 0 },
      unchecked: 0,
      unmaskable: 0,
      question: false,
    };
    // (a) red when the terminal or log words, a standing's words or the question clause change;
    //     (b) prints the lines and the words.
    expect({
      terminal: inspectReceiptLine({ ...base, terminal: true, members: ['declared:SHOP_TOKEN'] }),
      log: inspectReceiptLine({
        ...base,
        terminal: false,
        hidden: { declared: 1, environment: 1, pattern: 0 },
      }),
      standings: [
        declaredWords({ declared: 'resolved' }),
        declaredWords({ declared: 'resolved', declaredCause: 'no_manifest' }),
        declaredWords({ declared: 'partial', declaredCause: 'manifest_changed' }),
        declaredWords({ declared: 'unknown', declaredCause: 'load_failed' }),
        declaredWords({ declared: 'unknown', declaredCause: 'no_manifest' }),
      ],
      question: inspectReceiptLine({ ...base, terminal: false, question: true }).endsWith(
        `; ${QUESTION_DECLARED_ONLY_WORDS}.`,
      ),
    }).toEqual({
      terminal:
        "Disclosure: declared values resolved; environment values and values after a credential's name are shown on this terminal; hidden 1 declared: declared:SHOP_TOKEN; 0 not checked; 0 too short to hide.",
      log: 'Disclosure: declared values resolved; environment swept; hidden 1 declared, 1 environment, 0 by pattern; 0 not checked; 0 too short to hide.',
      standings: [
        'declared values resolved',
        'declared values resolved (no manifest)',
        'declared values partial (manifest changed)',
        'declared values unknown (load failed)',
        'declared values unknown (no manifest)',
      ],
      question: true,
    });
  });
});

describe(`${MANIFEST_PAGE} — keys, messages and what a run records (correction 1)`, () => {
  let root: string;
  beforeEach(() => {
    clearProjectExtensionsCache();
    root = mkdtempSync(join(tmpdir(), 'realm-docs-729-manifest-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const definitionIn = (dir: string) =>
    ({
      id: 'docs-manifest',
      name: 'm',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'human',
      source_dir: dir,
      trust_root: dir,
    }) as WorkflowDefinition;

  it("the connect guide's example: a project with no `realm.yaml` reads `resolved` (D-11)", async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "`resolved`, as here, where the workflow's project has no `realm.yaml` and so declares none;",
    );
    const m = await readRunManifest(definitionIn(root), undefined, {});
    // (a) red when a project without a manifest reads otherwise; (b) prints the state, the cause
    //     and the count of declared values.
    expect([m.declaredState, m.declaredCause ?? null, Object.keys(m.declared).length]).toEqual([
      'resolved',
      null,
      0,
    ]);
  });

  it('8 top-level keys, `disclosure` among them', () => {
    claim(MANIFEST_PAGE, 'This page lists its 8 top-level keys,');
    claim(
      MANIFEST_PAGE,
      '| `disclosure` | No | The environment variables whose values Realm shows. Added after version 0.47.1. |',
    );
    const keys = Object.keys(DEPLOYMENT_MANIFEST_JSON_SCHEMA.properties);
    // (a) red when a key is added or dropped without the page; (b) prints the keys.
    expect({ count: keys.length, disclosure: keys.includes('disclosure') }).toEqual({
      count: 8,
      disclosure: true,
    });
  });

  it("a builder's message hides the environment and a Bearer token; a short secret's warning names the file and the key (F3, F37)", async () => {
    // Correction 2: the pages that say a load error is masked where it is caught (the stored half is
    // `load-project-extensions-identity-failure.test.ts`'s F3 cell).
    claim(
      'CHANGELOG.md',
      "A run's file keeps every value as it was given, except the error of a project that failed to load, which is masked where it is caught;",
    );
    claim(
      MANIFEST_PAGE,
      "Such a message also hides the values of the environment, the value after a credential's name and a token after `Bearer ` or `Basic `, as a log does (added after version 0.47.1).",
    );
    const example =
      "[realm] Secret 'SHOP_PIN' (in /srv/shop/realm.yaml, at handlers.show.config.pin) is shorter than 4 characters, so realm cannot recognise it in printed text without hiding ordinary words. It shows wherever it appears outside a credential's name: in replies, logs, exports and Slack posts (after a name such as password=, a surface that hides every kind still hides it). Fix: give it a value of at least 4 characters. It is hidden again from the next load at which it is that long.";
    claim(MANIFEST_PAGE, example);
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('DOCS_729_LOAD_ENV', 'FAKE-LOAD-ENV-0729');
    writeFileSync(
      join(root, 'handlers.mjs'),
      "export function makeStrict() { throw new Error('cannot reach ' + process.env.DOCS_729_LOAD_ENV + ' with Bearer FAKEtok9abc'); }\nexport function makeShow({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n",
      'utf8',
    );
    writeFileSync(join(root, '.env'), 'SHOP_PIN=k9w\n', 'utf8');
    writeFileSync(
      join(root, 'realm.yaml'),
      'version: 1\nhandlers:\n  show:\n    use: ./handlers.mjs#makeShow\n    config: { pin: "${secret:SHOP_PIN}" }\n',
      'utf8',
    );
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    await loadProjectExtensions(definitionIn(root));
    writeFileSync(
      join(root, 'realm.yaml'),
      'version: 1\nhandlers:\n  show:\n    use: ./handlers.mjs#makeStrict\n    config: {}\n',
      'utf8',
    );
    clearProjectExtensionsCache();
    const thrown = await loadProjectExtensions(definitionIn(root)).then(
      () => '',
      (e: Error) => e.message,
    );
    // (a) red when the warning drops the file or the key or changes its words, or a builder's
    //     message shows the environment value or the token; (b) prints the warning (path replaced)
    //     and two booleans.
    expect({
      warning: warned
        .find((w) => w.includes("Secret 'SHOP_PIN'"))
        ?.replace(join(root, 'realm.yaml'), '/srv/shop/realm.yaml'),
      envShown: thrown.includes('FAKE-LOAD-ENV-0729'),
      tokenShown: thrown.includes('FAKEtok9abc'),
    }).toEqual({ warning: example, envShown: false, tokenShown: false });
  });

  it("`secrets_block_hash` for the page's file, and which edits keep a run's declared values (D-12, R28)", async () => {
    claim(
      MANIFEST_PAGE,
      "A run made after version 0.47.1 also records `secrets_block_hash`, a hash of the file's `secrets` block alone. For the file at the top of this page it is `f57efad2e80ef275ec3bbaf1b1b50421d8bb3273ca2a8cf47005e4166c701a07`.",
    );
    claim(
      MANIFEST_PAGE,
      'They treat the file as unchanged for the run while it still refers to every secret the run recorded and, when the run recorded `secrets_block_hash`, its `secrets` block is the same. Adding `disclosure:`, a handler with a secret of its own, or any other edit keeps earlier runs exportable. Removing a secret a run referred to, or changing the `secrets` block, makes them read `partial`, and `realm run export` then refuses them unless it is given `--accept-partial-disclosure`. A run made by version 0.47.1 or earlier recorded no `secrets_block_hash`, so for it only the names are compared: a change to the `secrets` block alone is not noticed.',
    );
    // Correction 2: the upgrade guide's qualifier (R28) and the connect guide's two conditions (D-12).
    claim(
      UPGRADE_PAGE,
      "Adding `disclosure:` to `realm.yaml` does not make earlier runs refuse `realm run export`: only removing a secret a run referred to does, or, for a run made by this version, changing the manifest's `secrets` block (a run made by 0.47.1 or earlier is judged by its secret names alone;",
    );
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "`partial`, with `declared_cause: manifest_changed`, when the run's manifest no longer refers to a secret the run recorded, or its `secrets` block changed since the run recorded it;",
    );
    const page = read(MANIFEST_PAGE);
    const fileSection = page.slice(page.indexOf('## The file'));
    const yamlStart = fileSection.indexOf('```yaml\n') + '```yaml\n'.length;
    const topFile = loadYaml(
      fileSection.slice(yamlStart, fileSection.indexOf('\n```', yamlStart)),
    ) as Parameters<typeof manifestSecretsBlockHash>[0];
    const secrets = 'secrets:\n  sources: [dotenv]\n  dotenv: .env\n';
    const adapter =
      'adapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n';
    writeFileSync(join(root, '.env'), 'SVC_TOKEN=FAKE-SVC-0729\nNEW_TOKEN=FAKE-NEW-0729\n', 'utf8');
    writeFileSync(join(root, '.env.other'), 'SVC_TOKEN=FAKE-SVC-0729\n', 'utf8');
    const yaml = `version: 1\n${secrets}${adapter}`;
    const entry = (blockHash?: string) =>
      ({
        extension_identity: [
          {
            manifest: {
              path: join(root, 'realm.yaml'),
              content_hash: 'recorded',
              ...(blockHash !== undefined ? { secrets_block_hash: blockHash } : {}),
            },
            secret_names: ['SVC_TOKEN'],
          },
        ],
      }) as unknown as RunRecord;
    const standing = async (text: string, run: RunRecord) => {
      writeFileSync(join(root, 'realm.yaml'), text, 'utf8');
      const m = await readRunManifest(definitionIn(root), run, {});
      return m.declaredState;
    };
    writeFileSync(join(root, 'realm.yaml'), yaml, 'utf8');
    const recordedHash = manifestSecretsBlockHash(
      loadYaml(yaml) as Parameters<typeof manifestSecretsBlockHash>[0],
    );
    const newRun = entry(recordedHash);
    const oldRun = entry();
    const otherBlock = `version: 1\nsecrets:\n  sources: [dotenv]\n  dotenv: .env.other\n${adapter}`;
    // (a) red when the page's hash is not the code's, an edit the page lists reads otherwise, or an
    //     old run notices a block change; (b) prints the hash's agreement and each state.
    expect({
      pageHash: manifestSecretsBlockHash(topFile),
      disclosureAdded: await standing(`${yaml}disclosure:\n  not_secret: [APP_REGION]\n`, newRun),
      handlerAdded: await standing(
        `${yaml}  more:\n    use: github\n    config: { token: "\${secret:NEW_TOKEN}" }\n`,
        newRun,
      ),
      secretRemoved: await standing(`version: 1\n${secrets}`, newRun),
      blockChanged: await standing(otherBlock, newRun),
      oldRunBlockChanged: await standing(otherBlock, oldRun),
    }).toEqual({
      pageHash: 'f57efad2e80ef275ec3bbaf1b1b50421d8bb3273ca2a8cf47005e4166c701a07',
      disclosureAdded: 'resolved',
      handlerAdded: 'resolved',
      secretRemoved: 'partial',
      blockChanged: 'partial',
      oldRunBlockChanged: 'resolved',
    });
  });
});

describe(`${UPGRADE_PAGE} and the CHANGELOG — the sentences this correction changes`, () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the upgrade guide: what is hidden from an agent, a log and an export, and what shows it', () => {
    claim(
      UPGRADE_PAGE,
      "From the version after 0.47.1, what Realm prints is masked for who reads it: an agent, a log and an export hide every environment value of 8 or more characters (see [What the output hides](operate-runs.md#what-the-output-hides)). Name the ordinary variables you want to see in `REALM_NOT_SECRET`, or in a manifest's `disclosure.not_secret`.",
    );
    // (a) red when an audience stops hiding an environment value, or REALM_NOT_SECRET or a
    //     manifest's list stops showing it; (b) prints booleans.
    expect({
      hidden: (['agent', 'log', 'file'] as const).map(
        (a) => !shown(`x ${ENV_VALUE}`, a).includes(ENV_VALUE),
      ),
      byEnvList: shown(
        `x ${ENV_VALUE}`,
        'log',
        setFor('log', { REALM_NOT_SECRET: 'SVC_VALUE' }),
      ).includes(ENV_VALUE),
      byManifest: shown(`x ${ENV_VALUE}`, 'log', setFor('log', {}, ['SVC_VALUE'])).includes(
        ENV_VALUE,
      ),
    }).toEqual({ hidden: [true, true, true], byEnvList: true, byManifest: true });
  });

  it("the CHANGELOG's sentences: the scheme anchors, what is never masked, the user name, builder errors, a guard's conditions (F30)", async () => {
    claim(
      'CHANGELOG.md',
      '(`password=…`, `"client_secret": "…"`, `Authorization: Bearer …`), a token after `Bearer ` or `Basic `, the text after `token=`, and a URL\'s password (one holding `/` or a `"` is not read).',
    );
    claim(
      'CHANGELOG.md',
      "`PWD`, `OLDPWD` and `_`, which the shell sets to paths, are not treated as secrets, and neither are Realm's own settings, such as `REALM_OPERATOR` and `REALM_MCP_GATE_ANSWERS`; a value another, unlisted variable also holds is still hidden.",
    );
    claim(
      'CHANGELOG.md',
      'What an agent, a log or a broadcast is shown hides the home folder and the user name when they are 8 or more characters long, and every other environment value under the home folder, whole;',
    );
    claim(
      'CHANGELOG.md',
      "and also hide the environment's values, the value after a credential's name, a token after `Bearer ` or `Basic `, and the text after `token=`.",
    );
    claim(
      'CHANGELOG.md',
      'A later step that reads `<guard>.conditions`, in a `when:` for one, finds nothing there.',
    );
    const dir = mkdtempSync(join(tmpdir(), 'realm-docs-729-f30-'));
    try {
      const def = {
        id: 'docs-f30',
        name: 'f30',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          a: { description: 'A.', execution: 'agent', depends_on: [] },
          g: {
            description: 'G.',
            execution: 'guard',
            depends_on: ['a'],
            abort_unless: ['a.ok == true'],
          },
          q: {
            description: 'Q.',
            execution: 'agent',
            depends_on: ['g'],
            when: ['g.conditions.0.passed == true'],
          },
        },
      } as WorkflowDefinition;
      const store = new JsonFileStore(join(dir, 'runs'));
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeChain(store, def, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({ ok: true }),
      });
      const after = await store.get(run.id);
      const set = setFor('log', {
        PWD: '/srv/fake-work-0729',
        REALM_OPERATOR: 'fake-operator-0729',
        REALM_MCP_GATE_ANSWERS: 'withheld',
      });
      // (a) red when an ordinary word after a scheme hides or a token shows, a shell path or a
      //     setting is masked, the 8-character rule moves, or a later step finds the conditions
      //     in the guard's output; (b) prints texts, a list and booleans (fake values).
      expect({
        anchors: shown('Bearer of the news; Bearer FAKEtok9abc', 'log'),
        neverMasked: shown('/srv/fake-work-0729 fake-operator-0729 withheld', 'log', set),
        // Correction 2: the shadow rule — the same value under an unlisted variable is hidden.
        shadow: shown(
          'fake-operator-0729',
          'log',
          setFor('log', { REALM_OPERATOR: 'fake-operator-0729', OTHER_X: 'fake-operator-0729' }),
        ),
        urlNotRead: shown('https://u:pa/ss9@host.test/x', 'log'),
        shortUser: shown('by fu7', 'log', setFor('log', { USER: 'fu7' })),
        guardOutputKeys: Object.keys(after.evidence.find((e) => e.step_id === 'g')!.output_summary),
        laterStepSkipped: after.skipped_steps.includes('q'),
      }).toEqual({
        anchors: 'Bearer of the news; Bearer [REDACTED]',
        neverMasked: '/srv/fake-work-0729 fake-operator-0729 withheld',
        shadow: '[REDACTED]',
        urlNotRead: 'https://u:pa/ss9@host.test/x',
        shortUser: 'by fu7',
        guardOutputKeys: ['aborted'],
        laterStepSkipped: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #729 PR-3 correction 2: the pages' changed sentences ────────────────────────────────────────
const KINDS_PAGE = 'docs/concepts/step-kinds.md';

describe('#729 PR-3 correction 2 — the pages this correction changes', () => {
  it("step-kinds.md: a guard's conditions are on its Diagnostics line, not in its Output", async () => {
    const lines = [
      'Output: {"aborted":true,"abort_message":"High-risk refunds are not automated."}',
      `Diagnostics: ~1 tokens (estimate, step input) | no preconditions | guard: assess.risk == 'low' → failed ("high")`,
    ];
    for (const l of lines) claim(KINDS_PAGE, l);
    claim(
      KINDS_PAGE,
      "`realm run inspect` shows the guard's step with its `Output:`, and each condition on its `Diagnostics:` line — whether it passed, and the value it was checked against:",
    );
    const dir = mkdtempSync(join(tmpdir(), 'realm-docs-c2-guard-'));
    try {
      const def = {
        id: 'refunds',
        name: 'refunds',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          assess: { description: 'Assess.', execution: 'agent', depends_on: [] },
          only_low_risk: {
            description: 'Stop the run unless the refund is low risk.',
            execution: 'guard',
            depends_on: ['assess'],
            abort_unless: ["assess.risk == 'low'"],
            abort_message: 'High-risk refunds are not automated.',
          },
        },
      } as WorkflowDefinition;
      const store = new JsonFileStore(join(dir, 'runs'));
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeChain(store, def, {
        runId: run.id,
        command: 'assess',
        input: { risk: 'high' },
        dispatcher: async (_c, input) => input,
      });
      const workflowStore = {
        get: async () => def,
        list: async () => [def],
        register: async () => {},
      };
      const out = (await inspectRun(run.id, store, workflowStore as never))
        .split('\n')
        .map((l) => l.trim());
      // (a) red when the guard's conditions move out of its Diagnostics line, or the page's lines are
      //     not what inspect prints; (b) prints two booleans.
      expect(lines.map((l) => out.includes(l))).toEqual([true, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realm-run-reading.md: inspect's line ends with the question clause when it shows a question (C2)", async () => {
    claim(
      READING_PAGE,
      "When the record shows a gate's question, the line ends `; question: declared tier only`: a question hides only the declared secrets.",
    );
    const home = mkdtempSync(join(tmpdir(), 'realm-docs-c2-q-'));
    try {
      const def = {
        id: 'asks',
        name: 'asks',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          g: {
            description: 'G.',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: { choices: ['approve', 'reject'], message: 'Ship to {{ run.params.region }}?' },
          },
        },
      } as WorkflowDefinition;
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const runId = (
        await runs.create({ workflowId: 'asks', workflowVersion: 1, params: { region: ENV_VALUE } })
      ).run.id;
      await executeChain(runs, def, {
        runId,
        command: 'g',
        input: {},
        dispatcher: async () => ({ preview: 'x' }),
      });
      const r = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', runId], {
        cwd: home,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          NO_COLOR: '1',
          REALM_NOT_SECRET: 'HOME',
          DOCS_C2_REGION: ENV_VALUE,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const last = r.stdout.trim().split('\n').at(-1) ?? '';
      // (a) red when inspect prints the question at the log's tier (the environment value hidden, no
      //     clause); (b) prints two booleans.
      expect({
        clause: last.endsWith('; question: declared tier only.'),
        questionShown: r.stdout.includes(`Ship to ${ENV_VALUE}?`),
      }).toEqual({ clause: true, questionShown: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("the CHANGELOG: realm's own words are shown whole; a listed name that is not set warns; the home folder rule; repairActFor's command", async () => {
    claim(
      'CHANGELOG.md',
      "Realm's own words — a run's phase and the gate-answers value where they stand alone, a completed run's reason, a printed command, the `user@host` label that names who took a step — are shown whole.",
    );
    claim(
      'CHANGELOG.md',
      'Each names environment variables whose values are not treated as secrets.',
    );
    claim(
      'CHANGELOG.md',
      "A listed name that is not set draws a warning that names where it is listed. Realm's own settings are not treated as secrets. A path under your home folder is hidden in a log, except inside a command Realm prints.",
    );
    claim(
      'CHANGELOG.md',
      "The shell command a repair act names (`rm <path>`, `chmod u+r <path>`), alone, beside the act's words; the error a run's damaged workflow copy raises carries it as `details.repair_command`, and the CLI prints it whole.",
    );
    const { repairActFor, parseFailureError, getWorkflowForRun } = await import('@sensigo/realm');
    const home = mkdtempSync(join(tmpdir(), 'realm-docs-c2-words-'));
    try {
      const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
      await workflows.register({
        id: 'words',
        name: 'w',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
      } as WorkflowDefinition);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const done = (await runs.create({ workflowId: 'words', workflowVersion: 1, params: {} })).run;
      // A phase printed while another variable holds the same word.
      const ended = (await runs.create({ workflowId: 'words', workflowVersion: 1, params: {} }))
        .run;
      await executeChain(runs, (await workflows.get('words'))!, {
        runId: ended.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({ ok: true }),
      });
      const env = {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        NO_COLOR: '1',
        REALM_NOT_SECRET: 'HOME,FAKE_UNSET_0729',
        STATUS_X: 'completed',
        MODE_X: 'withheld',
      };
      const inspected = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', ended.id], {
        cwd: home,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const checked = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'mcp', '--check', '--gate-answers', 'withheld'],
        { cwd: home, env, encoding: 'utf8', timeout: 60_000 },
      );
      const file = join(home, '.realm', 'workflows', 'words.json');
      writeFileSync(file, 'not json');
      const copyError = await getWorkflowForRun(workflows, done, {
        retryVerb: 'retry',
        verb: 'run',
      }).catch((e: unknown) => e as { details?: Record<string, unknown> });
      // (a) red when the phase, the gate-answers value or the fixed reason is hidden by another
      //     variable holding the word, the unset listed name is silent, or the repair command is not
      //     carried alone; (b) prints booleans and the command (a fake path).
      expect({
        phase: inspected.stdout.split('\n').some((l) => l.startsWith('Phase: completed')),
        gateAnswers: checked.stdout.includes('Gate answers over MCP: withheld ('),
        unsetWarns: `${inspected.stderr}${inspected.stdout}`.includes(
          "REALM_NOT_SECRET lists 'FAKE_UNSET_0729'",
        ),
        command: repairActFor(parseFailureError('/p/w.json', { kind: 'not_json' }))?.command,
        carried: (copyError as { details?: Record<string, unknown> }).details?.['repair_command'],
      }).toEqual({
        phase: true,
        gateAnswers: true,
        unsetWarns: true,
        command: 'rm /p/w.json',
        carried: `rm ${file}`,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── #729 PR-3 correction 3: the pages this correction changes ───────────────────────────────────

const CHANGELOG = 'CHANGELOG.md';

/** The built CLI in a fresh process, piped (a log), with only the environment given. */
function pipedCli(args: string[], env: Record<string, string>, cwd: string) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** The built CLI on a terminal (a pseudo-terminal through `script`), its output with `\r` dropped. */
function terminalCli(args: string[], env: Record<string, string>, cwd: string): string {
  const q = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, CLI_ENTRY, ...args];
  const argv =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-qec', command.map(q).join(' '), '/dev/null'];
  const r = spawnSync('script', argv, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', SHELL: '/bin/sh', ...env },
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r.stdout.replaceAll('\r', '');
}

const C3_MANIFEST =
  'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n';

/**
 * A run of a damaged workflow copy whose record names its project's manifest; its step's input and
 * output and its open question hold the declared value. `intact` keeps the manifest, `invalid`
 * makes it invalid (`load_failed`), `gone` removes it (`manifest_changed`); `none` registers the
 * workflow with no project and leaves the copy readable (`no_manifest`).
 */
let c3Count = 0;
async function c3Run(
  base: string,
  state: 'intact' | 'invalid' | 'gone' | 'none',
  plainOutputs = false,
): Promise<{ home: string; runId: string }> {
  // Correction 4 (I-9b): `plainOutputs` runs the steps with outputs that hold no declared value.
  const output = plainOutputs ? 'FAKEplain0729c4' : DECLARED;
  c3Count += 1;
  const home = join(base, `home-${state}-${c3Count}`);
  const project = join(base, `project-${state}-${c3Count}`);
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(project, 'realm.yaml'), C3_MANIFEST);
  writeFileSync(join(project, '.env'), `SVC_TOKEN=${DECLARED}\n`);
  const definition = {
    id: 'c3docs',
    name: 'c3docs',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    ...(state === 'none' ? {} : { trust_root: project }),
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
  } as WorkflowDefinition;
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definition);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const { run } = await store.create({
    workflowId: 'c3docs',
    workflowVersion: 1,
    params: { key: DECLARED },
  });
  const { executeStep } = await import('@sensigo/realm');
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
  if (state !== 'none') {
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
    writeFileSync(join(home, '.realm', 'workflows', 'c3docs.json'), 'not json');
    if (state === 'gone') rmSync(path);
    if (state === 'invalid') writeFileSync(path, 'version: 1\nnot_a_key: true\n');
  }
  return { home, runId: run.id };
}

/** Correction 4: one recorded failed attempt on `runId` whose problem's message holds the declared
 *  value (the sidecar, independent of the run's file). */
async function c3Attempt(home: string, runId: string): Promise<void> {
  const { FailedAttemptStore, buildFailedAttemptRecord, serializeFailedAttemptLine } =
    await import('@sensigo/realm');
  const rec = buildFailedAttemptRecord({
    run_id: runId,
    workflow_id: 'c3docs',
    step_id: 'a',
    ts: '2026-10-21T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [
      {
        instancePath: '/key',
        schemaPath: '#/properties/key/enum',
        keyword: 'enum',
        message: `must not be ${DECLARED}`,
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

describe('#729 PR-3 correction 3 — the pages this correction changes', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'realm-docs-c3-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("a manifest's own text: masked where it is printed, as typed on the terminal, the path after realm's words", async () => {
    const sentence =
      'A message about the text of your own deployment manifest, such as a malformed `${secret:…}` reference, is masked wherever it is printed, so on your own terminal it shows as you typed it';
    claim(OPERATE_PAGE, `${sentence}.`);
    claim(
      CHANGELOG,
      `${sentence}; its key path now follows Realm's words (\`malformed secret reference '…' at <path>\`).`,
    );
    claim(
      MANIFEST_PAGE,
      "| Has a name in small letters | `malformed secret reference '${secret:lower}' at handlers.show.config.a — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.` |",
    );
    claim(
      MANIFEST_PAGE,
      "| Is not closed | `malformed secret reference '${secret:OPEN' at handlers.show.config.b — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.` |",
    );
    const { parseDeploymentManifest } = await import('@sensigo/realm');
    const parsed = parseDeploymentManifest(
      'version: 1\nhandlers:\n  show:\n    use: ./h.js#H\n    config: { a: "${secret:lower}", b: "${secret:OPEN" }\n',
    );
    const errors = 'error' in parsed && parsed.error.kind === 'schema' ? parsed.error.errors : [];
    const home = join(base, 'home');
    const project = join(base, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(
      join(project, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:fakeFragment0729x}" }\n',
    );
    writeFileSync(join(project, '.env'), '');
    writeFileSync(
      join(project, 'workflow.yaml'),
      'id: c3m\nname: c3m\nversion: 1\nsteps:\n  a:\n    description: A.\n    execution: agent\n',
    );
    const line = (text: string) =>
      text
        .split('\n')
        .find((l) => l.includes('malformed secret reference'))
        ?.trim();
    const logged = pipedCli(['workflow', 'validate', 'workflow.yaml'], { HOME: home }, project);
    const typed = terminalCli(['workflow', 'validate', 'workflow.yaml'], { HOME: home }, project);
    const FORM = ' — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.';
    // (a) red when the path precedes realm's words, the parser's message is not masked in a log, or
    //     is masked on the terminal; (b) prints the two rows' messages and the two lines (fake text).
    expect({ errors, logged: line(logged.stderr), typed: line(typed) }).toEqual({
      errors: [
        `malformed secret reference '\${secret:lower}' at handlers.show.config.a${FORM}`,
        `malformed secret reference '\${secret:OPEN' at handlers.show.config.b${FORM}`,
      ],
      logged: `malformed secret reference '\${secret:[REDACTED]' at adapters.svc.config.token${FORM}`,
      typed: `malformed secret reference '\${secret:fakeFragment0729x}' at adapters.svc.config.token${FORM}`,
    });
  }, 60_000);

  it("a run's values are withheld while its declared secrets cannot be read; the flag prints them; a damaged copy alone reads the record's manifest", async () => {
    for (const sentence of [
      "When Realm cannot read a run's declared secrets — the deployment manifest the run's record names cannot be read, or it changed or is gone since the run recorded it — it withholds the run's values.",
      '`realm run inspect`, `realm run attempts` and every MCP reply about the run print each stored value as its type and size, and the question as `withheld (declared values could not be read)` or `withheld (declared values changed)`.',
      'Ids, step names, phases and the commands Realm prints still show.',
      'Give `inspect` or `attempts` `--accept-partial-disclosure` to print the values masked with what is known; `realm run export` needs it to write the file.',
      'A run whose workflow names no manifest is not withheld (added after version 0.47.1).',
    ])
      claim(OPERATE_PAGE, sentence);
    claim(
      READING_PAGE,
      "When the run's workflow copy cannot be read, `inspect` reads the deployment manifest the run's record names.",
    );
    claim(
      READING_PAGE,
      "When Realm still cannot read the run's declared secrets, because that manifest cannot be read, or changed or is gone since the run recorded it, `inspect` withholds the run's values: the first line says why and names the flag, each stored value prints as its type and size, the question prints as `Question: withheld (declared values could not be read — pass --accept-partial-disclosure)` (or `declared values changed`), and the `Disclosure:` line ends `; values withheld: <n> shown as their type and size`.",
    );
    claim(
      READING_PAGE,
      'Ids, step names, the phase, the health findings and the commands it prints still show. With `--accept-partial-disclosure`, the values print masked with what is known.',
    );
    // Correction 4 (I-4): `attempts`'s sentence changed; the correction-4 cell quotes and executes it.
    claim(
      RECORD_PAGE,
      "When the run's workflow copy cannot be read, Realm reads the deployment manifest the run's record names, so a damaged copy alone does not make the declared secrets unknown; while they are not known, `realm run inspect` and `realm run attempts` print the run's values as their type and size unless given the same flag (added after version 0.47.1)",
    );
    claim(
      CHANGELOG,
      "When the deployment manifest a run's record names cannot be read, or changed or is gone since the run recorded it, `realm run inspect`, `realm run attempts` and every MCP reply about the run print each stored value as its type and size, and the question as `withheld (declared values could not be read)` or `withheld (declared values changed)`.",
    );
    claim(
      CHANGELOG,
      "A run whose workflow names no manifest, and a server given no `disclosureProvider`, are not withheld. When a run's workflow copy cannot be read, Realm reads the manifest the run's record names.",
    );
    const inspect = async (state: 'intact' | 'invalid' | 'gone' | 'none', flag = false) => {
      const { home, runId } = await c3Run(base, state);
      const r = pipedCli(
        ['run', 'inspect', runId, ...(flag ? ['--accept-partial-disclosure'] : [])],
        { HOME: home, REALM_NOT_SECRET: 'HOME' },
        base,
      );
      const lineOf = (start: string) =>
        r.stdout
          .split('\n')
          .find((l) => l.trimStart().startsWith(start))
          ?.trim();
      return {
        home,
        runId,
        leaked: r.stdout.includes(DECLARED),
        first: r.stdout.split('\n')[0]?.split(':')[0],
        question: lineOf('Question:'),
        phase: lineOf('Phase:'),
        receipt: r.stdout.trim().split('\n').at(-1)?.split('; ').at(-1),
      };
    };
    const invalid = await inspect('invalid');
    const exported = pipedCli(
      ['run', 'export', invalid.runId, '--out', join(base, 'x.json')],
      { HOME: invalid.home, REALM_NOT_SECRET: 'HOME' },
      base,
    );
    // Correction 4 (I-5; MA 1's ruling): `attempts` says so only with attempts to show, so the run
    // gets one recorded failed attempt first.
    await c3Attempt(invalid.home, invalid.runId);
    const attempts = pipedCli(
      ['run', 'attempts', invalid.runId],
      { HOME: invalid.home, REALM_NOT_SECRET: 'HOME' },
      base,
    );
    const shown = await inspect('invalid', true);
    // (a) red when values print under a failed or changed manifest, the question or its words
    //     differ, a fact is shaped, the flag is ignored, export writes without it, attempts says
    //     nothing or prints its problem as text, a damaged copy alone reads unknown, or a run with no
    //     manifest is withheld; (b) prints booleans, line heads, the question lines and the
    //     receipts' last clauses.
    expect({
      invalid: [invalid.leaked, invalid.first, invalid.question, invalid.phase, invalid.receipt],
      gone: (await inspect('gone')).question,
      exportRefused: [exported.status, exported.stderr.startsWith('Refusing to export')],
      attemptsSaid: attempts.stderr.startsWith(
        'Values withheld (declared values could not be read)',
      ),
      attemptShaped:
        attempts.stdout
          .split('\n')
          .find((l) => l.startsWith('    '))
          ?.trim()
          .startsWith('‹string, ') ?? false,
      flagShows: shown.leaked,
      intact: await inspect('intact').then((r) => [r.leaked, r.first]),
      none: (await inspect('none')).first,
    }).toEqual({
      invalid: [
        false,
        'Values withheld (declared values could not be read)',
        'Question: withheld (declared values could not be read — pass --accept-partial-disclosure)',
        'Phase: gate_waiting',
        // Correction 4 (I-9): the two hash lines are shown as their type and size too (4 → 6).
        'values withheld: 6 shown as their type and size.',
      ],
      gone: 'Question: withheld (declared values changed — pass --accept-partial-disclosure)',
      exportRefused: [1, true],
      attemptsSaid: true,
      attemptShaped: true,
      flagShows: true,
      intact: [false, 'Run'],
      none: 'Run',
    });
  }, 120_000);

  it("realm's own words show whole while another variable holds the same word, at each surface the pages name", async () => {
    const sentence =
      "Realm's own words show whole while another variable holds the same word: a run's phase where it stands alone (`realm run inspect`, `run list`, `run advance`, `run abandon`, `run export`, and `realm agent --run-id` on a run that has ended), the gate-answers value on `--check`'s lines, and a fixed reason on `inspect`'s `Cause:` and `abandon`'s `Reason:` (`Workflow completed.`, `Abandoned via realm run abandon`, `Abandoned via abandon_run`).";
    claim(ENV_PAGE, sentence);
    claim(
      CHANGELOG,
      "That covers `inspect`'s `Cause:`, `abandon`'s `Reason:`, the default reason `abandon_run` writes, `run list`'s phase column, `advance`'s last line, `--check`'s value line and the sentence `realm agent --run-id` prints for a run that has ended.",
    );
    const home = join(base, 'home');
    mkdirSync(home);
    const { abandonRun, executeStep } = await import('@sensigo/realm');
    const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    const def = (id: string, execution: 'agent' | 'auto') =>
      ({
        id,
        name: id,
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { a: { description: 'A.', execution, depends_on: [] } },
      }) as WorkflowDefinition;
    await workflows.register(def('words', 'agent'));
    await workflows.register(def('autowords', 'auto'));
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const create = async (id = 'words') =>
      (await runs.create({ workflowId: id, workflowVersion: 1, params: {} })).run.id;
    const done = await create();
    await executeStep(runs, def('words', 'agent'), {
      runId: done,
      command: 'a',
      input: {},
      dispatcher: async () => ({ ok: true }),
    });
    const viaMcp = await create();
    await abandonRun(runs, viaMcp, 'Abandoned via abandon_run');
    const live = await create();
    const auto = await create('autowords');
    const env = (word: string) => ({ HOME: home, REALM_NOT_SECRET: 'HOME', STATUS_X: word });
    const out = (args: string[], word: string, extra: Record<string, string> = {}) => {
      const r = pipedCli(args, { ...env(word), ...extra }, base);
      return `${r.stdout}${r.stderr}`;
    };
    const find = (text: string, start: string) =>
      text
        .split('\n')
        .find((l) => l.trimStart().startsWith(start))
        ?.trim();
    // 8 or more characters: a shorter environment value is not masked at all.
    const abandoned = out(['run', 'abandon', live], 'Abandoned').split('\n')[0] ?? '';
    // (a) red when one of the surfaces prints its word as plain text (`[REDACTED]`); (b) prints each
    //     surface's line or its relevant part.
    expect({
      cause: find(out(['run', 'inspect', done], 'completed'), 'Cause:'),
      causeMcp: find(out(['run', 'inspect', viaMcp], 'abandon_run'), 'Cause:'),
      reason: abandoned.slice(abandoned.indexOf(' Reason: ')),
      list: out(['run', 'list'], 'abandoned')
        .split('\n')
        .find((l) => l.startsWith(viaMcp))
        ?.split(/\s{2,}/)[2],
      advance: out(['run', 'advance', auto], 'completed').trim().split('\n').at(-1),
      check: find(
        out(['mcp', '--check', '--gate-answers', 'withheld'], 'withheld', { MODE_X: 'withheld' }),
        'The gate-answers value:',
      )?.split(' (')[0],
      agent: find(
        out(['agent', '--run-id', viaMcp, '--model', 'anthropic:fake-model-0729'], 'abandoned', {
          ANTHROPIC_API_KEY: 'fake-key-0729',
        }),
        'Error:',
      ),
    }).toEqual({
      cause: 'Cause: Workflow completed.',
      causeMcp: 'Cause: Abandoned via abandon_run',
      reason: ' Reason: Abandoned via realm run abandon.',
      list: 'abandoned',
      advance: `Run ${auto}: phase 'completed'`,
      check: 'The gate-answers value: withheld',
      agent: `Error: Run ${viaMcp} has already ended (abandoned): an operator ended it.`,
    });
  }, 120_000);

  it("a credential's name after a backslash, and a value in escaped quotes, are read", () => {
    // Correction 7 (C7-5): the clause on a quote inside a value written without quotes is executed
    // by the CHANGELOG cell "a quote inside a value written without quotes ends it only where it
    // closes" below and by redaction.test.ts "correction 7"; the text glued to a closing quote by
    // redaction.test.ts "correction 1 (C1-5, J)" and "(C1-5, J″)" (correction 7, correction 1).
    claim(
      TOOLS_PAGE,
      "A credential's name is also read after a backslash, as in a Windows path (`C:\\app\\token: …`), and a value written in escaped quotes, such as `password=\\'…\\'`, is hidden to its closing quote, and so is what is glued to that quote unless it is only closing brackets or quotes before a blank, `&`, `;` or `,` (or the text ends there); a quote met inside a value written without quotes is part of it, unless a quote of the same kind was left open before the name (a `'` between two letters, as in it's, never opens one) and the quote closes — after any closing brackets or quotes, a blank, `&`, `;` or `,` follows, or the text ends (added after version 0.47.1).",
    );
    claim(
      CHANGELOG,
      "A credential's name is also read after a backslash (`C:\\app\\token: …`), and a value in escaped quotes (`password=\\'…\\'`) is hidden to its closing quote, and so is what is glued to that quote unless it is only closing brackets or quotes before a blank, `&`, `;` or `,` (or the text ends there).",
    );
    const set = setFor('log');
    // (a) red when the bare name stops at the backslash's letter, or an escaped-quoted value whose
    //     quote is already open on its line is read as an unquoted one (nothing is hidden), or —
    //     correction 7, correction 1 (round 9): the own closer's closing-run reading dropped — a
    //     brace glued to the closer before a blank is hidden (`\\'} next` loses its `}`) or a glued
    //     letter is shown (`\\'}x` shows `}x` after the kept quote); (b) prints the four shown texts
    //     (fake values and markers).
    expect([
      disclose('C:\\app\\token: FAKEwin0729bcd', set, 'all').text,
      disclose("note \\'x export PASSWORD=\\'FAKEesc0729bcd\\' && go", set, 'all').text,
      disclose("password=\\'FAKEr9w1\\'} next", set, 'all').text,
      disclose("password=\\'FAKEr9w2\\'}x", set, 'all').text,
    ]).toEqual([
      'C:\\app\\token: [REDACTED]',
      "note \\'x export PASSWORD=\\'[REDACTED]\\' && go",
      "password=\\'[REDACTED]\\'} next",
      "password=\\'[REDACTED]\\'[REDACTED]",
    ]);
  });
});

// ── #729 PR-3 correction 4: the pages this correction changes ───────────────────────────────────

const MCP_TOOLS_PAGE = 'docs/reference/mcp/tools.md';

/**
 * Correction 4 (I-11, I-7): a project whose manifest declares the canary; one run abandoned with
 * `reason` stored, one live run with nothing run. Each record names the manifest. `gone` damages the
 * copy and removes the manifest (`manifest_changed`).
 */
let c4Count = 0;
async function c4Ended(
  base: string,
  state: 'intact' | 'gone',
  reason: string,
): Promise<{ home: string; ended: string; live: string }> {
  c4Count += 1;
  const home = join(base, `home-c4-${state}-${c4Count}`);
  const project = join(base, `project-c4-${state}-${c4Count}`);
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(project, 'realm.yaml'), C3_MANIFEST);
  writeFileSync(join(project, '.env'), `SVC_TOKEN=${DECLARED}\n`);
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
    id: 'c4docs',
    name: 'c4docs',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    trust_root: project,
    steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
  } as WorkflowDefinition);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const path = join(project, 'realm.yaml');
  const create = async (): Promise<string> => {
    const { run } = await store.create({ workflowId: 'c4docs', workflowVersion: 1, params: {} });
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
  const { abandonRun } = await import('@sensigo/realm');
  await abandonRun(store, ended, reason);
  if (state === 'gone') {
    writeFileSync(join(home, '.realm', 'workflows', 'c4docs.json'), 'not json');
    rmSync(path);
  }
  return { home, ended, live };
}

describe('#729 PR-3 correction 4 — the pages this correction changes', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'realm-docs-c4-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const cli = (home: string, args: string[]) =>
    pipedCli(args, { HOME: home, REALM_NOT_SECRET: 'HOME' }, base);
  const first = (text: string) => text.split('\n')[0]?.split(':')[0];
  const problem = (text: string) =>
    text
      .split('\n')
      .find((l) => l.startsWith('    '))
      ?.trim();
  const lastClause = (text: string) => text.trim().split('\n').at(-1)?.split('; ').at(-1);

  it("realm-run-reading.md: `attempts` says so only with attempts to show, also when it cannot read the run's record; the flag prints them and says so", async () => {
    claim(
      READING_PAGE,
      "`attempts` reads the run's declared secrets as `inspect` does. When it cannot read them — or cannot read the run's record — and it has attempts to show, it says so on standard error and prints each problem as its type and size; with `--accept-partial-disclosure` it prints them masked with what is known and says so.",
    );
    const bare = await c3Run(base, 'invalid');
    const none = cli(bare.home, ['run', 'attempts', bare.runId]);
    const held = await c3Run(base, 'invalid');
    await c3Attempt(held.home, held.runId);
    const withheld = cli(held.home, ['run', 'attempts', held.runId]);
    const accepted = cli(held.home, ['run', 'attempts', held.runId, '--accept-partial-disclosure']);
    const damaged = await c3Run(base, 'intact');
    await c3Attempt(damaged.home, damaged.runId);
    writeFileSync(join(damaged.home, '.realm', 'runs', `${damaged.runId}.json`), 'not json');
    const record = cli(damaged.home, ['run', 'attempts', damaged.runId]);
    // (a) red when the line prints with no attempts, a run record that cannot be read withholds
    //     nothing, or the flag prints them without saying so; (b) prints the first stderr lines'
    //     heads, booleans and the problem lines' heads.
    expect({
      none: none.stderr.includes('Values '),
      withheld: [first(withheld.stderr), problem(withheld.stdout)?.startsWith('‹string, ')],
      accepted: [first(accepted.stderr), problem(accepted.stdout)?.includes(DECLARED)],
      record: [first(record.stderr), problem(record.stdout)?.startsWith('‹string, ')],
    }).toEqual({
      none: false,
      withheld: ['Values withheld (declared values could not be read)', true],
      accepted: [
        'Values shown on --accept-partial-disclosure (declared values could not be read)',
        true,
      ],
      record: ['Values withheld (declared values could not be read)', true],
    });
  }, 120_000);

  it('realm-run-reading.md and operate-runs.md: under the flag, where it would have withheld, the first line and the receipt say the values were shown on it; export says so too', async () => {
    // #729 PR-3 correction 5 (J-6): the receipt says so in its question clause only when a question
    // was shown; export's last line swaps its question clause under the flag, and the file keeps
    // the record's truth (`question: declared_only`).
    claim(
      READING_PAGE,
      "Under `--accept-partial-disclosure`, where the values would have been withheld, `inspect` prints `Values shown on --accept-partial-disclosure (…)` first and, when the record shows a gate's question, the line ends `; question: shown with what is known (--accept-partial-disclosure)`.",
    );
    // #879 (C2): the export paragraph's fourth sentence
    claim(
      READING_PAGE,
      "When `--accept-partial-disclosure` wrote a run that `export` refuses without it, the line ends `; written on --accept-partial-disclosure (refused without it)`; where the run's manifest changed or could not be read, the question's clause before it reads `question: shown with what is known` instead, and the file's own `disclosure` keeps `question: declared_only`.",
    );
    claim(
      OPERATE_PAGE,
      "`inspect`'s first line and `export`'s last line say so; `inspect`'s receipt says so in its question clause when a question was shown.",
    );
    const gone = await c3Run(base, 'gone');
    const inspected = cli(gone.home, ['run', 'inspect', gone.runId, '--accept-partial-disclosure']);
    const out = join(base, 'c4.json');
    const exported = cli(gone.home, [
      'run',
      'export',
      gone.runId,
      '--out',
      out,
      '--accept-partial-disclosure',
    ]);
    const header = (JSON.parse(readFileSync(out, 'utf8')) as { disclosure?: { question?: string } })
      .disclosure?.question;
    // The question-less arm: a withheld run that shows no question, on the flag.
    const bare = await c4Ended(base, 'gone', 'Held.');
    const plain = cli(bare.home, ['run', 'inspect', bare.live, '--accept-partial-disclosure']);
    const receipt = plain.stdout.split('\n').find((l) => l.startsWith('Disclosure:')) ?? '';
    // (a) red when the words are not swapped under the flag, no first line names it, export's last
    //     line keeps `declared tier only` beside the flag, names the flag twice or does not say the
    //     run was refused without it (#879), the file's header changes, or a receipt with no
    //     question names the flag or a question; (b) prints the first lines' heads, the last clauses
    //     (realm's words), the flag's count in export's line, the header and booleans.
    expect({
      first: first(inspected.stdout),
      receipt: lastClause(inspected.stdout),
      exported: exported.stdout.trim().split('\n').at(-1)?.split('; ').slice(-2),
      // #879: the export line names the flag once
      exportedFlags:
        (exported.stdout.trim().split('\n').at(-1) ?? '').split('--accept-partial-disclosure')
          .length - 1,
      header,
      bareFirst: first(plain.stdout),
      bareReceipt: {
        flag: receipt.includes('--accept-partial-disclosure'),
        question: receipt.includes('question'),
      },
    }).toEqual({
      first: 'Values shown on --accept-partial-disclosure (declared values changed)',
      receipt: 'question: shown with what is known (--accept-partial-disclosure).',
      exported: [
        'question: shown with what is known',
        'written on --accept-partial-disclosure (refused without it)',
      ],
      exportedFlags: 1,
      header: 'declared_only',
      bareFirst: 'Values shown on --accept-partial-disclosure (declared values changed)',
      bareReceipt: { flag: false, question: false },
    });
  }, 120_000);

  describe("#879: the export's third line", () => {
    /** Export's third line: its last printed line, without the two spaces before it. */
    const thirdLine = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? '';
    /** How many times the line names the flag (the issue's acceptance: once). */
    const flagCount = (line: string): number =>
      line.split('--accept-partial-disclosure').length - 1;

    it('on the flag, the branches no other cell pins: a run with no question, and a run with no project, which export refuses without the flag', async () => {
      // #879 (C2): (a) red when the CHANGELOG bullet or the page's version sentence loses its words;
      //     (b) prints the sentence. This cell runs the opening and the last clause; the J-6 cell
      //     above runs the question clause without the flag's name.
      claim(
        CHANGELOG,
        "- **`realm run export`'s third line says what it counts, and names `--accept-partial-disclosure` once (issue #879).**",
      );
      claim(
        CHANGELOG,
        'It opens `masked in the file:` (it was `masked:`): its counts are what the file hides, not what the lines printed above it hide.',
      );
      claim(
        CHANGELOG,
        'When the flag wrote a run that export refuses without it, the line ends `; written on --accept-partial-disclosure (refused without it)`; it ended `; shown on --accept-partial-disclosure`, and a run with no project said nothing of the flag.',
      );
      claim(
        CHANGELOG,
        "Where the run's manifest changed or could not be read, a question's clause before it reads `question: shown with what is known`; it named the flag too.",
      );
      claim(
        READING_PAGE,
        'It was added after version 0.47.1; its opening, its question clause and its last clause changed after version 0.48.0.',
      );
      const ended = await c4Ended(base, 'gone', 'Held.');
      const live = cli(ended.home, [
        'run',
        'export',
        ended.live,
        '--out',
        join(base, '879-live.json'),
        '--accept-partial-disclosure',
      ]);
      const none = await c3Run(base, 'none');
      const noneOut = join(base, '879-none.json');
      const refused = cli(none.home, ['run', 'export', none.runId, '--out', noneOut]);
      const refusedWritten = existsSync(noneOut);
      const accepted = cli(none.home, [
        'run',
        'export',
        none.runId,
        '--out',
        noneOut,
        '--accept-partial-disclosure',
      ]);
      // (a) red when a run the flag wrote does not end its line saying it was refused without it
      //     (keyed on the cause, a run with no project loses the clause), names the flag twice, or
      //     opens without `in the file`; a run with no project is not refused without the flag; or
      //     a question-less run's line holds a question; (b) prints exit codes, whether the refused
      //     export wrote a file, whether the refusal names the missing project, each third line
      //     (realm's words and counts) and the flag's count in it.
      expect({
        live: [live.status, thirdLine(live.stdout), flagCount(thirdLine(live.stdout))],
        noneRefused: [
          refused.status,
          refusedWritten,
          refused.stderr.includes(
            '— the run has no project (its workflow copy records no deployment root).',
          ),
        ],
        noneAccepted: [
          accepted.status,
          thirdLine(accepted.stdout),
          flagCount(thirdLine(accepted.stdout)),
        ],
      }).toEqual({
        live: [
          0,
          'masked in the file: declared secrets partial (manifest changed); environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 too short to hide; written on --accept-partial-disclosure (refused without it)',
          1,
        ],
        noneRefused: [1, false, true],
        noneAccepted: [
          0,
          'masked in the file: declared secrets unknown (no manifest); environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 too short to hide; question: declared tier only; written on --accept-partial-disclosure (refused without it)',
          1,
        ],
      });
    }, 120_000);

    it("on the flag, a run whose manifest could not be read: the question's clause shows what is known, and the line names the flag once", async () => {
      const held = await c3Run(base, 'invalid');
      const exported = cli(held.home, [
        'run',
        'export',
        held.runId,
        '--out',
        join(base, '879-invalid.json'),
        '--accept-partial-disclosure',
      ]);
      // #886 correction (K2): (a) red when `load_failed` drops out of the question clause's cause
      //     (it then reads `question: declared tier only`), the opening or the last clause changes,
      //     or the line names the flag more than once; (b) prints the exit code, the third line
      //     (realm's words and counts) and the flag's count in it.
      expect({
        invalid: [
          exported.status,
          thirdLine(exported.stdout),
          flagCount(thirdLine(exported.stdout)),
        ],
      }).toEqual({
        invalid: [
          0,
          'masked in the file: declared secrets unknown (load failed); environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 too short to hide; question: shown with what is known; written on --accept-partial-disclosure (refused without it)',
          1,
        ],
      });
    }, 120_000);

    it('"in the file": piped, the first line is masked as any printed line is and can hide a value the third line does not count', async () => {
      // #879 (C2): (a) red when the page drops the sentence this cell runs; (b) prints it.
      claim(
        READING_PAGE,
        'Piped or redirected, the first line is masked as any printed line is, so it can hide a value the third line does not count.',
      );
      const run = await c3Run(base, 'intact');
      // not `base` (no path the run recorded holds it) and not the cwd (MA 1's F2 design would
      // exempt a variable equal to the working directory)
      const folder = mkdtempSync(join(tmpdir(), 'realm-879-out-'));
      try {
        const exported = pipedCli(
          ['run', 'export', run.runId, '--out', folder],
          { HOME: run.home, REALM_NOT_SECRET: 'HOME', REALM_TEST_879_DIR: folder },
          base,
        );
        const lines = exported.stdout.trim().split('\n');
        // #886 correction (K3): a failed export writes no file, and reading it unguarded throws a
        // message holding the folder's path; so the cell carries whether the file was written and
        // its count only — never the path, never a snippet of the file (-1: missing or not JSON).
        const target = join(folder, `${run.runId}.realm.json`);
        const written = existsSync(target);
        const text = written ? readFileSync(target, 'utf8') : '';
        let fileEnvironment = -1;
        try {
          const file = JSON.parse(text) as { disclosure: { hidden: { environment: number } } };
          fileEnvironment = file.disclosure.hidden.environment;
        } catch {
          fileEnvironment = -1;
        }
        // (a) red when the export writes no file, the opening loses `in the file`, the first line
        //     prints the folder's path whole, or the file counts or holds the path; (b) prints the
        //     exit code, booleans (the file written, the first line masked, the path in the file),
        //     the third line and the file's count — never the path.
        expect({
          code: exported.status,
          written,
          firstMasked:
            (lines[0] ?? '').includes('[REDACTED]') && !(lines[0] ?? '').includes(folder),
          third: thirdLine(exported.stdout),
          fileEnvironment,
          pathInFile: text.includes(folder),
        }).toEqual({
          code: 0,
          written: true,
          firstMasked: true,
          third:
            'masked in the file: declared secrets resolved; environment swept; hidden 6 declared, 0 environment, 0 by pattern; 0 too short to hide; question: declared tier only',
          fileEnvironment: 0,
          pathInFile: false,
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }, 120_000);
  });

  it('a hash of a value the masking hid, or shaped, is shown as its type and size with it; where values print whole, so do their hashes (realm-run-reading.md, run-record-and-export.md, tools.md, the CHANGELOG); `(none to show)`', async () => {
    // #729 PR-3 correction 5 (J-6): `shown as its type and size`, never `hidden` (the marker).
    const sentence =
      "A hash of a value the masking hid, or shaped, is shown as its type and size with it (a short value's digest would confirm a guess); where values print whole, so do their hashes.";
    claim(READING_PAGE, sentence);
    claim(MCP_TOOLS_PAGE, sentence);
    claim(
      RECORD_PAGE,
      "A hash of a value the masking hid, or shaped, is shown as its type and size with it (a short value's digest would confirm a guess); where values print whole, so do their hashes (added after version 0.47.1)",
    );
    claim(CHANGELOG, sentence);
    claim(
      READING_PAGE,
      "and the first 8 characters of its hash, or its type and size when the masking hid anything inside the step's output or the run's values are withheld.",
    );
    claim(
      READING_PAGE,
      'When it printed none as its type and size, the line ends `; values withheld (none to show)`.',
    );
    const held = await c3Run(base, 'invalid');
    const withheld = cli(held.home, ['run', 'inspect', held.runId]);
    const intact = await c3Run(base, 'intact', true);
    const shown = cli(intact.home, ['run', 'inspect', intact.runId]);
    const stored = await new JsonFileStore(join(intact.home, '.realm', 'runs')).get(intact.runId);
    const masked = await c3Run(base, 'intact');
    const hidInside = cli(masked.home, ['run', 'inspect', masked.runId]);
    const hashLines = (text: string) =>
      text
        .split('\n')
        .flatMap((l) => l.match(/hash: (‹string, 8 characters›|[0-9a-f]{8})/)?.[0] ?? []);
    // The agent's walk, as the door makes it under withholding (the tables the door uses).
    const door = discloseRecord(
      stored,
      buildDisclosureSet({
        env: {},
        declared: { SVC_TOKEN: DECLARED },
        declaredState: 'unknown',
        declaredCause: 'load_failed',
        audience: 'agent',
      }).set,
      'agent',
      { withhold: 'load_failed' },
    ).record.evidence.map((e) => e.evidence_hash);
    const empty = await c4Ended(base, 'gone', 'Held.');
    const nothing = cli(empty.home, ['run', 'inspect', empty.live]);
    // (a) red when a hash prints as text where values are withheld (inspect, the agent's walk) or
    //     where the masking hid anything inside its output, or is shaped where values print whole,
    //     or the clause counts nothing; (b) prints the hash lines (shapes and the fake run's own
    //     hex), the door's digests (shapes) and the last clauses.
    expect({
      withheld: hashLines(withheld.stdout),
      hidInside: hashLines(hidInside.stdout),
      shown: hashLines(shown.stdout),
      door,
      none: lastClause(nothing.stdout),
    }).toEqual({
      withheld: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      hidInside: ['hash: ‹string, 8 characters›', 'hash: ‹string, 8 characters›'],
      shown: stored.evidence.map((e) => `hash: ${e.evidence_hash.slice(0, 8)}`),
      door: ['‹string, 64 characters›', '‹string, 64 characters›'],
      none: 'values withheld (none to show).',
    });
  }, 120_000);

  it("realm-run-reading.md: `diff`'s one flag; its hash columns as their type and size while a run's declared secrets cannot all be read; the CHANGELOG", async () => {
    claim(
      READING_PAGE,
      "Its one flag is `--accept-partial-disclosure`: `diff` reads each run's declared secrets as `inspect` does, and while it cannot read them all, the first line says so and the hashes print as their type and size unless the flag is given.",
    );
    claim(
      READING_PAGE,
      "| `--accept-partial-disclosure` | Prints the outputs' hashes when Realm cannot read every declared secret of either run, masked with what is known. Added after version 0.47.1. |",
    );
    claim(
      READING_PAGE,
      "A hash is shown as its type and size while the run's declared secrets cannot all be read, or when the masking hid anything inside that output (as `inspect` does).",
    );
    claim(
      CHANGELOG,
      "`realm run diff` reads each run's declared secrets the same way and takes the same flag.",
    );
    const held = await c3Run(base, 'invalid');
    const stored = await new JsonFileStore(join(held.home, '.realm', 'runs')).get(held.runId);
    const hex = stored.evidence[0]!.evidence_hash.slice(0, 8);
    const withheld = cli(held.home, ['run', 'diff', held.runId, held.runId]);
    const accepted = cli(held.home, [
      'run',
      'diff',
      held.runId,
      held.runId,
      '--accept-partial-disclosure',
    ]);
    const row = (text: string) => text.split('\n').find((l) => l.startsWith('a '));
    // (a) red when diff reads no manifest (the hex prints while withheld), the flag is ignored, or
    //     the comparison mark is shaped; (b) prints line heads, counts and booleans.
    expect({
      withheld: [
        first(withheld.stdout),
        (row(withheld.stdout)?.match(/‹string, 8 characters›/g) ?? []).length,
        row(withheld.stdout)?.includes(hex),
        row(withheld.stdout)?.includes(' = '),
      ],
      accepted: [first(accepted.stdout), row(accepted.stdout)?.includes(hex)],
    }).toEqual({
      withheld: ['Values withheld (declared values could not be read)', 2, false, true],
      accepted: [
        'Values shown on --accept-partial-disclosure (declared values could not be read)',
        true,
      ],
    });
  }, 120_000);

  it("realm-run-reading.md: export's refusal for a run whose copy cannot be read and whose record names no manifest names the copy's repair", async () => {
    claim(
      READING_PAGE,
      "For a run whose workflow copy cannot be read and whose record names no manifest, it reads `Repair the run's workflow copy first (realm run inspect <run-id> names the command), or pass --accept-partial-disclosure to write it masked with what is known; the last line it prints then names the state.`",
    );
    const home = join(base, 'home-copy');
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
      id: 'c4copy',
      name: 'c4copy',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition);
    writeFileSync(join(home, '.realm', 'workflows', 'c4copy.json'), 'not json');
    const { run } = await new JsonFileStore(join(home, '.realm', 'runs')).create({
      workflowId: 'c4copy',
      workflowVersion: 1,
      params: {},
    });
    const refused = cli(home, ['run', 'export', run.id, '--out', join(base, 'copy.json')]);
    const inspected = cli(home, ['run', 'inspect', run.id]);
    // (a) red when the run is told to restore a manifest it never had; (b) prints the exit code,
    //     the refusal's end (realm's words, a fake id) and whether inspect names a command.
    expect({
      status: refused.status,
      end: refused.stderr.slice(refused.stderr.indexOf('Repair')).trim(),
      inspectNamesCommand: /\brm [^\s)]+/.test(`${inspected.stdout}${inspected.stderr}`),
    }).toEqual({
      status: 1,
      end: `Repair the run's workflow copy first (realm run inspect ${run.id} names the command), or pass --accept-partial-disclosure to write it masked with what is known; the last line it prints then names the state.`,
      inspectNamesCommand: true,
    });
  }, 60_000);

  it("realm-run-acting.md and realm-agent.md: an ended run's stored reason is masked like the record's values, and its shape while its declared secrets cannot all be read", async () => {
    const tail =
      "the reason is stored text, masked like the record's values, and shown as its type and size while the run's declared secrets cannot all be read (`realm run inspect <id> --accept-partial-disclosure` reads it";
    claim(
      ACTING_PAGE,
      "The reason is stored text: it is masked like the record's values, and shown as its type and size while the run's declared secrets cannot all be read (`realm run inspect <id> --accept-partial-disclosure` reads it). Added after version 0.47.1.",
    );
    claim(
      AGENT_PAGE,
      `For a run that failed or was abandoned, a \`Reason:\` line follows: ${tail}`,
    );
    const reason = `upstream refused key ${DECLARED}`;
    const intact = await c4Ended(base, 'intact', reason);
    const gone = await c4Ended(base, 'gone', reason);
    const reasonOf = (stdout: string) => {
      const line = stdout.split('\n')[0] ?? '';
      return line.slice(line.indexOf(' Reason: ') + 1);
    };
    const kept = cli(intact.home, ['run', 'abandon', intact.ended]);
    const held = cli(gone.home, ['run', 'abandon', gone.ended]);
    const agent = pipedCli(
      ['agent', '--run-id', gone.ended, '--model', 'anthropic:fake-model-0729'],
      { HOME: gone.home, REALM_NOT_SECRET: 'HOME', ANTHROPIC_API_KEY: 'fake-key-0729' },
      base,
    );
    const named = `Run realm run inspect ${gone.ended} --accept-partial-disclosure to print them`;
    // (a) red when the reason prints as text (the canary shows) or no line names the command that
    //     reads it; (b) prints the Reason: texts (fake words, a marker, shapes) and booleans.
    expect({
      kept: reasonOf(kept.stdout),
      held: [reasonOf(held.stdout), held.stderr.includes(named)],
      agent: [
        agent.stderr.split('\n').find((l) => l.startsWith('Reason:')),
        agent.stderr.includes(named),
      ],
    }).toEqual({
      kept: 'Reason: upstream refused key [REDACTED].',
      held: [`Reason: ‹string, ${reason.length} characters›.`, true],
      agent: [`Reason: ‹string, ${reason.length} characters›`, true],
    });
  }, 120_000);
});

// ── #729 PR-3 correction 5: the CHANGELOG's and the record page's new sentences, each executed ──

describe('#729 PR-3 correction 5 — the new sentences, executed on the built realm', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'realm-docs-c5-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  /** The built CLI, piped, from `cwd` (default: outside any project), in `home`. */
  const cli = (home: string, args: string[], cwd = base, env: Record<string, string> = {}) =>
    pipedCli(args, { HOME: home, REALM_NOT_SECRET: 'HOME', ...env }, cwd);
  const C5_DECLARED = 'FAKE-C5-DOCS-DECLARED-01';

  /** A project (`package.json`, a realm.yaml declaring `value`) and one agent step whose `when` is
   *  never true (no model is ever called), registered from it; returns its folder and HOME. */
  function c5Project(value: string): { home: string; proj: string } {
    const home = join(base, 'home');
    const proj = join(base, 'proj');
    mkdirSync(join(home, '.realm'), { recursive: true });
    mkdirSync(join(proj, 'workflows', 'wf'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(proj, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n',
    );
    writeFileSync(join(proj, '.env'), `SVC_TOKEN=${value}\n`);
    writeFileSync(
      join(proj, 'workflows', 'wf', 'workflow.yaml'),
      'id: c5docs\nname: c5docs\nversion: 1\nsteps:\n  first:\n    description: First\n    execution: agent\n    depends_on: []\n    when: "run.params.go == true"\n',
    );
    const reg = cli(home, ['workflow', 'register', 'workflows/wf/workflow.yaml'], proj);
    if (reg.status !== 0) throw new Error(`fixture: register failed: ${reg.stderr}`);
    return { home, proj };
  }

  /** `realm agent --workflow` from the project: the run is created and never runs a step. */
  function c5Started(home: string, proj: string): string {
    cli(
      home,
      ['agent', '--workflow', 'workflows/wf/workflow.yaml', '--model', 'anthropic:fake-c5'],
      proj,
      {
        ANTHROPIC_API_KEY: 'fake-c5-key',
      },
    );
    const runs = join(home, '.realm', 'runs');
    const file = readdirSync(runs).find((f) => f.endsWith('.json'));
    if (file === undefined) throw new Error('fixture: no run was created');
    return file.slice(0, -'.json'.length);
  }

  it("the CHANGELOG: a run's phase prints whole on every command, also where a variable or a declared value holds the same word", () => {
    claim(
      CHANGELOG,
      "A run's phase prints whole on every command, also where a variable or a declared value holds the same word.",
    );
    // A variable: `resume` refuses a completed run, naming its phase.
    const home = join(base, 'home-var');
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    const at = '2026-01-01T00:00:00.000Z';
    writeFileSync(
      join(home, '.realm', 'runs', 'c5-done.json'),
      JSON.stringify({
        id: 'c5-done',
        workflow_id: 'c5wf',
        workflow_version: 1,
        completed_steps: ['a'],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        skip_details: {},
        claims: {},
        run_phase: 'completed',
        version: 1,
        params: {},
        evidence: [],
        created_at: at,
        updated_at: at,
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        sealed_by: { arm: 'complete' },
      }),
    );
    const resumed = cli(home, ['run', 'resume', 'c5-done', '--from', 'a'], base, {
      STATUS_X: 'completed',
    });
    // A declared value: the project's realm.yaml declares `running`, and `realm agent` stops its
    // drive with the run open.
    const { home: home2, proj } = c5Project('running');
    const drive = cli(
      home2,
      ['agent', '--workflow', 'workflows/wf/workflow.yaml', '--model', 'anthropic:fake-c5'],
      proj,
      {
        ANTHROPIC_API_KEY: 'fake-c5-key',
      },
    );
    // (a) red when either phase prints as plain text (`[REDACTED]`); (b) prints the two lines' ends.
    expect([
      resumed.stderr.split('\n').find((l) => l.includes('not resumable')),
      drive.stderr
        .split('\n')
        .find((l) => l.includes('The drive stops'))
        ?.split('stays open ')[1],
    ]).toEqual([
      "Run c5-done is in phase 'completed', which is not resumable.",
      "(phase 'running'):",
    ]);
  }, 120_000);

  it("the CHANGELOG: a quoted value whose closing quote is on the next line is hidden through the break; with none on either line, to its line's end, and the lines after it show", () => {
    claim(
      CHANGELOG,
      "A quoted value whose closing quote stands on the next line is hidden through the line break (a line that a backslash continues before its break counts as the same line); one with no closing quote on its line or the next is hidden to its line's end, and the lines after it show.",
    );
    const set = buildDisclosureSet({
      env: {},
      declared: {},
      declaredState: 'resolved',
      audience: 'log',
    }).set;
    const shown = (text: string) => disclose(text, set, 'all').text;
    // The continuation clause is executed by redaction.test.ts "correction 6 — J-1 backslash
    // continuation" (the CRLF cell).
    // (a) red when the next line is not looked at, or the value runs past its line; (b) prints the
    //     shown texts (fake canaries, markers).
    expect([
      shown('password="FAKEc5d1\nFAKEc5d2" rest'),
      shown('password=\\"FAKEc5d3\nFAKEc5d4\\" rest'),
      shown('password="FAKEc5d5\nCompleted: (none)\nCreated: 2026'),
    ]).toEqual([
      'password="[REDACTED]\n[REDACTED]" rest',
      'password=\\"[REDACTED]\n[REDACTED]\\" rest',
      'password="[REDACTED]\nCompleted: (none)\nCreated: 2026',
    ]);
  });

  it('the CHANGELOG: a quote inside a value written without quotes ends it only where it closes, and the next line’s closing quote is read as one', () => {
    claim(
      CHANGELOG,
      "A quote met inside a value written without quotes (`password=ab'cd`) ends the value only when a quote of the same kind was left open before the name (a `'` between two letters, as in it's, never opens one) and the quote closes — what follows it, after any closing brackets or quotes (`}` `]` `)` `\"` `'`), is a blank, `&`, `;` or `,`, or the text ends there; otherwise it is part of the value, which is hidden whole. The quote that closes a quoted value on the line after it opened is read as that closing quote, so a value later on that line is read as if no quote were open.",
    );
    const set = buildDisclosureSet({
      env: {},
      declared: {},
      declaredState: 'resolved',
      audience: 'log',
    }).set;
    const shown = (text: string) => disclose(text, set, 'all').text;
    // Executed in full by redaction.test.ts "correction 7" (each glue, each terminator, the closing
    // run, the next line's closer); here one text per clause (the apostrophe: correction 7,
    // correction 1). (a) red when the sentence is edited
    // or removed (the quote mismatch is printed), or a clause stops holding; (b) prints the shown
    // texts (fake canaries, markers).
    expect([
      shown("password=ab'cdFAKEc7l1 next"),
      shown("echo 'run password=Xk9'}qFAKEc7l2"),
      shown("echo 'run password=Xk9' next"),
      shown("it's refreshToken=Xk9' next"),
      shown('{"a":"password=FAKEc7l3"}'),
      shown("token='FAKEc7l4\\\nFAKEc7l5\nFAKEc7l6' rest  refreshToken=Xk9' next"),
    ]).toEqual([
      'password=[REDACTED] next',
      "echo 'run password=[REDACTED]",
      "echo 'run password=[REDACTED]' next",
      "it's refreshToken=[REDACTED] next",
      '{"a":"password=[REDACTED]"}',
      "token='[REDACTED]\n[REDACTED]\n[REDACTED]' rest  refreshToken=[REDACTED] next",
    ]);
  });

  it("run-record-and-export.md: when a program that loaded a project creates the run, its first identity entry carries `origin: 'start'` and names the project's manifest when it has one; drift is judged from the other entries only", () => {
    // #729 PR-3 correction 6 (C6-4): the sentence qualified. Its four arms and the cells that
    // execute them: the manifest named — this cell (and start-identity-c5-729 "`realm agent
    // --workflow`"); an entry naming none — start-identity-c5-729 "C6-1 (3)"; no entry from a creator
    // with no loaded project — start-identity-c5-729 "`create_workflow` on a bare `realm mcp`"; no
    // entry in a store that does not keep the field — start-identity-c5-729 "a store that does not
    // keep 'extension_identity'".
    claim(
      RECORD_PAGE,
      "When a program that loaded a project creates the run, its first identity entry carries `origin: 'start'` and names the project's manifest when it has one; a creator with no loaded project, or a store that does not keep `extension_identity`, writes none. Drift is judged from the other entries only (added after version 0.47.1).",
    );
    const { home, proj } = c5Project(C5_DECLARED);
    const runId = c5Started(home, proj);
    const record = JSON.parse(
      readFileSync(join(home, '.realm', 'runs', `${runId}.json`), 'utf8'),
    ) as RunRecord;
    const advanced = cli(home, ['run', 'advance', runId]);
    const fit = advanced.stdout.split('\n').find((l) => l.startsWith('This program:')) ?? '';
    // (a) red when the run is born with no start entry, or its manifest unnamed, or the start entry
    //     is judged as an execution; (b) prints the entries' origins, whether the manifest is the
    //     project's, and the fit words.
    expect({
      origins: (record.extension_identity ?? []).map((e) => e.origin ?? 'execution'),
      manifest: record.extension_identity?.[0]?.manifest?.path === join(proj, 'realm.yaml'),
      fit: fit.slice(fit.indexOf('project code: ')),
    }).toEqual({
      origins: ['start'],
      manifest: true,
      fit: 'project code: not comparable — the run has recorded no project code yet.',
    });
  }, 120_000);

  it('the CHANGELOG: when a program that loaded a project creates a run, the run records its manifest, or that it has none, so a run that never ran a step is withheld too', () => {
    // #729 PR-3 correction 6 (C6-4): the clause qualified, as the record page's sentence.
    claim(
      CHANGELOG,
      "When a program that loaded a project creates a run, the run records that project's manifest, or that it has none (a creator with no loaded project, or a store that does not keep the record, writes nothing), so a run that never ran a step is withheld too.",
    );
    const { home, proj } = c5Project(C5_DECLARED);
    const runId = c5Started(home, proj);
    cli(home, ['run', 'abandon', runId, '--reason', `key ${C5_DECLARED}`]);
    rmSync(join(proj, 'realm.yaml'));
    const out = cli(home, ['run', 'inspect', runId]).stdout.split('\n');
    // (a) red when a never-executed run's manifest is unknown (the reason prints, `resolved (no
    //     manifest)`); (b) prints the Cause line (a shape), the receipt's declared part and a
    //     boolean — never the canary.
    expect({
      cause: out.find((l) => l.startsWith('Cause:')),
      receipt: out.find((l) => l.startsWith('Disclosure:'))?.split(';')[0],
      shown: out.join('\n').includes(C5_DECLARED),
    }).toEqual({
      cause: `Cause: ‹string, ${`key ${C5_DECLARED}`.length} characters›`,
      receipt: 'Disclosure: declared values partial (manifest changed)',
      shown: false,
    });
  }, 120_000);
});
