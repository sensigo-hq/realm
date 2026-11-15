// scripts/corpus/record.mjs — CP-7: records what a PUBLISHED Realm release writes, so every later
// release's tests can read it back (packages/cli/src/corpus/corpus.test.ts). It drives the published
// CLI from a prepared folder of published packages (NM), as the website's replay recorder does
// (website/scripts/replay/record.mjs), and writes the release's corpus into
// packages/cli/src/corpus/<version>/:
//   - examples/<name>/workflow.yaml, the nine example workflow files from the git tag v<version> (no
//     package ships examples/), with a profiles/ folder where the example has one, and beside each
//     definition.json, what the published loader made of it (the runtime-only keys left out);
//   - realm.db.gz, the release's store holding two runs (examples/08-pr-review, answered at its human
//     gate, and scripts/corpus/one-step/workflow.yaml), copied by `realm db backup` and gzipped;
//   - runs/08-pr-review.realm.json and runs/one-step.realm.json, each run's `realm run export` bundle;
//   - project/realm.yaml and project/stand-in.env, the project the runs ran in (the token is a fake);
//   - manifest.json: the version, the published packages' integrity hashes, the recorder's version,
//     WORK, and the rules applied (packages/cli/src/corpus/corpus-rules.json).
// It deletes the folder's PENDING marker (Part B step 2 commits it). It never writes an exception file
// (`<artifact>.after-roundtrip.json`): only a person does, in a PR.
//
// Usage (the release checklist, Part B step 7a), from the repository root:
//   mkdir <nm> && cd <nm> && npm install --no-save @sensigo/realm-cli@<v> @sensigo/realm-testing@<v>
//   env -i PATH="$PATH" HOME=<any folder> NM=<nm> WORK=<empty folder> node scripts/corpus/record.mjs <v>
// WORK is a fixed absolute folder outside any home with no package.json or .git above it: the stored
// runs keep its path, and the gzipped store is committed as it is. The CLI runs with exactly
// { PATH, HOME: <WORK>/home }, so it never sees the caller's HOME or a real ~/.realm.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bumped when what the recorder writes, or how, changes. */
const RECORDER_VERSION = 1;
/** The test clock's instant: every stamp the CLI writes is this, and every duration 0. */
const START = '2026-01-01T09:00:00.000Z';
/** The mock GitHub's port, fixed so two recordings differ only in what the rules replace. */
const GITHUB_PORT = 47490;
const PR_PARAMS = { repo: 'acme/payments-api', pr_number: 42 };
const NOTE_PARAMS = { note: 'The corpus recorder drives the published CLI.' };
const STAND_IN_ENV = 'GITHUB_TOKEN=local-stand-in\n';
const GATE_WAIT_MS = 60_000;
const ALLOWED_ENV = ['PATH', 'HOME', 'NM', 'WORK'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const RULES_FILE = path.join(REPO, 'packages/cli/src/corpus/corpus-rules.json');

function stop(message) {
  console.error(`record.mjs: ${message}`);
  process.exit(1);
}

// 1. The environment: nothing but the four names, so no key or token can reach a recording.
const extra = Object.keys(process.env).filter((name) => !ALLOWED_ENV.includes(name));
if (extra.length > 0) {
  stop(
    `the environment holds names other than ${ALLOWED_ENV.join(', ')}: ${extra.sort().join(', ')}. ` +
      'Run it with env -i PATH="$PATH" HOME=<folder> NM=<nm> WORK=<folder>.',
  );
}
const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  stop('give the release version as the one argument, for example 0.49.0');
}
const { NM, WORK } = process.env;
if (!NM || !path.isAbsolute(NM))
  stop('NM must be the absolute path of the folder holding the published packages');
if (!WORK || !path.isAbsolute(WORK)) stop('WORK must be an absolute path');

// 2. NM holds the published packages at this version (the CLI, the testing package, and the loader's).
function installedVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(NM, 'node_modules', name, 'package.json'), 'utf8'))
      .version;
  } catch {
    return undefined;
  }
}
for (const name of ['@sensigo/realm-cli', '@sensigo/realm-testing', '@sensigo/realm']) {
  const found = installedVersion(name);
  if (found !== version) {
    stop(
      `${NM}/node_modules holds ${name} ${found ?? '(nothing)'}, not ${version}: ` +
        `npm install --no-save @sensigo/realm-cli@${version} @sensigo/realm-testing@${version} there first`,
    );
  }
}
let integrity;
try {
  const lock = JSON.parse(
    fs.readFileSync(path.join(NM, 'node_modules/.package-lock.json'), 'utf8'),
  );
  integrity = Object.fromEntries(
    [
      '@sensigo/realm-cli',
      '@sensigo/realm-testing',
      '@sensigo/realm',
      '@sensigo/realm-store-sqlite',
    ].map((name) => [name, lock.packages?.[`node_modules/${name}`]?.integrity ?? null]),
  );
} catch {
  stop(`${NM}/node_modules/.package-lock.json cannot be read: install the packages with npm there`);
}
if (integrity['@sensigo/realm-cli'] === null)
  stop('the lockfile names no integrity hash for the CLI');

// 3. WORK: empty, outside any home, with no package.json or .git above it.
fs.mkdirSync(WORK, { recursive: true });
const realWork = fs.realpathSync(WORK);
if (fs.readdirSync(realWork).length > 0) stop(`${WORK} is not empty: give an empty folder`);
const homes = [process.env.HOME, '/home', '/Users', '/root']
  .filter((p) => p !== undefined && p !== '')
  .map((p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  });
for (const home of homes) {
  if (home !== '/' && (realWork === home || realWork.startsWith(home + path.sep))) {
    stop(
      `${WORK} is inside ${home}: the stored runs keep WORK's path, so it must be outside any home`,
    );
  }
}
for (let dir = realWork; ; dir = path.dirname(dir)) {
  for (const marker of ['package.json', '.git']) {
    if (fs.existsSync(path.join(dir, marker))) {
      stop(
        `${path.join(dir, marker)} is above WORK: the loader would take that folder as the project`,
      );
    }
  }
  if (path.dirname(dir) === dir) break;
}

// 4. The corpus folder: absent, or holding only the PENDING marker.
const CORPUS = path.join(REPO, 'packages/cli/src/corpus', version);
if (fs.existsSync(CORPUS)) {
  const held = fs.readdirSync(CORPUS).filter((name) => name !== 'PENDING');
  if (held.length > 0) {
    stop(
      `${path.relative(REPO, CORPUS)} already holds ${held.join(', ')}: remove it to record again`,
    );
  }
}

const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
const NMURL = (rel) => pathToFileURL(path.join(NM, 'node_modules', rel)).href;
const { createTestHome, startGitHubMockServer } = await import(
  NMURL('@sensigo/realm-testing/dist/index.js')
);
const { loadWorkflowFromFileWithDiagnostics } = await import(NMURL('@sensigo/realm/dist/index.js'));

// 5. The work folder: the examples from the tag, the project, the test home.
const examplesAtTag = spawnSync(
  'git',
  ['ls-tree', '-d', '--name-only', `v${version}`, 'examples/'],
  {
    cwd: REPO,
    encoding: 'utf8',
  },
);
if (examplesAtTag.status !== 0)
  stop(`git cannot read the tag v${version}: ${examplesAtTag.stderr.trim()}`);
const examples = examplesAtTag.stdout
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => path.basename(line));
for (const name of examples) {
  const profiles = spawnSync(
    'git',
    ['ls-tree', '-d', '--name-only', `v${version}`, `examples/${name}/profiles`],
    { cwd: REPO, encoding: 'utf8' },
  ).stdout.trim();
  const paths = [`examples/${name}/workflow.yaml`, ...(profiles === '' ? [] : [profiles])];
  const archive = spawnSync('git', ['archive', `v${version}`, ...paths], { cwd: REPO });
  if (archive.status !== 0) stop(`git archive of ${paths.join(' ')} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', realWork], { input: archive.stdout });
  if (untar.status !== 0) stop(`tar failed for examples/${name}: ${untar.stderr}`);
}
const HOME = path.join(realWork, 'home');
const PROJECT = path.join(realWork, 'project');
fs.mkdirSync(PROJECT, { recursive: true });
await createTestHome({ root: path.join(HOME, '.realm'), start: new Date(START) });
const gh = await startGitHubMockServer(path.join(HERE, 'github-fixture.json'), GITHUB_PORT);
const realmYaml =
  `version: 1\nadapters:\n  github:\n    use: github\n` +
  `    config: { base_url: '${gh.url}', auth: { token: '\${secret:GITHUB_TOKEN}' } }\n`;
fs.writeFileSync(path.join(PROJECT, 'realm.yaml'), realmYaml);
fs.writeFileSync(path.join(PROJECT, '.env'), STAND_IN_ENV);
fs.copyFileSync(
  path.join(realWork, 'examples/08-pr-review/workflow.yaml'),
  path.join(PROJECT, 'workflow.yaml'),
);
fs.copyFileSync(path.join(HERE, 'one-step/workflow.yaml'), path.join(PROJECT, 'one-step.yaml'));
const MODULE = path.join(NM, 'corpus-provider-module.mjs');
fs.copyFileSync(path.join(HERE, 'provider-module.mjs'), MODULE);

// 6. The CLI, with exactly PATH and the work folder's HOME.
const CLI = path.join(NM, 'node_modules/@sensigo/realm-cli/dist/index.js');

const cliEnv = { PATH: process.env.PATH, HOME };
// The drives and the gate's answer record who drove them (`driven_by.by`): with no name given, the
// OS user and host name (`<user>@<host>`), which would put the recorder's own user and machine names
// into the committed store and bundles. `REALM_OPERATOR` names the driver instead: a fixed word under
// eight characters, so no masking ever hides it. Nothing else differs from cliEnv.
const OPERATOR = 'corpus';
const driveEnv = { ...cliEnv, REALM_OPERATOR: OPERATOR };
// What ran, for the manifest: the folders and ids as words, so no host path or id is committed.
const transcript = [];
const words = new Map([
  [NM, 'NM'],
  [realWork, 'WORK'],
]);
function shownArgs(args) {
  return args.map((arg) => {
    let shown = arg;
    for (const [value, word] of words) shown = shown.split(value).join(word);
    return shown;
  });
}
function cli(...args) {
  const drives = args[0] === 'agent' || (args[0] === 'run' && args[1] === 'respond');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: drives ? driveEnv : cliEnv,
    cwd: PROJECT,
    encoding: 'utf8',
  });
  transcript.push({ argv: ['realm', ...shownArgs(args)], exit: r.status });
  return r;
}
function must(r, what) {
  if (r.status !== 0) {
    stop(`${what} exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const TERMINAL = new Set(['completed', 'failed', 'abandoned', 'cancelled']);
function terminal(bundle) {
  return TERMINAL.has(bundle.run?.run_phase);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The 08 run. `realm workflow run` (the dev-mode runner) is interactive on 0.49.0 and refuses a
// stdin that is not a terminal, so `realm agent --workflow … --params …` creates the run. The agent
// WAITS at 08's human gate (it prints the gate line and polls the store every 3 s until the gate is
// answered, then finishes the run itself), so it is started with spawn, and the gate is answered
// while it runs: its id is read from a non-terminal export of the parked run.
must(
  cli('workflow', 'register', path.join(PROJECT, 'workflow.yaml')),
  'realm workflow register (08)',
);
const agentArgs = [
  'agent',
  '--workflow',
  path.join(PROJECT, 'workflow.yaml'),
  '--params',
  JSON.stringify(PR_PARAMS),
  '--provider-module',
  MODULE,
];
const agent = spawn(process.execPath, [CLI, ...agentArgs], {
  env: driveEnv,
  cwd: PROJECT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let agentOut = '';
let agentErr = '';
agent.stdout.setEncoding('utf8').on('data', (s) => (agentOut += s));
agent.stderr.setEncoding('utf8').on('data', (s) => (agentErr += s));
const agentExit = new Promise((done) => agent.on('close', (code) => done(code)));
let agentCode;
agentExit.then((code) => (agentCode = code));
transcript.push({ argv: ['realm', ...shownArgs(agentArgs)], exit: 'started' });
const parked = path.join(realWork, 'parked.json');
let prRun;
let gateId;
for (const began = Date.now(); Date.now() - began < GATE_WAIT_MS; await sleep(500)) {
  if (agentCode !== undefined) break;
  prRun ??= /^Run ID: ([0-9a-f-]{36})$/m.exec(agentOut)?.[1];
  if (prRun === undefined) continue;
  fs.rmSync(parked, { force: true });
  // Not through cli(): the polls are not part of the transcript.
  const r = spawnSync(process.execPath, [CLI, 'run', 'export', prRun, '--out', parked], {
    env: cliEnv,
    cwd: PROJECT,
    encoding: 'utf8',
  });
  if (r.status === 0 && fs.existsSync(parked)) {
    gateId = readJson(parked).run?.pending_gate?.gate_id;
    if (gateId !== undefined) break;
  }
}
fs.rmSync(parked, { force: true });
if (gateId === undefined) {
  agent.kill('SIGKILL');
  stop(`08's gate did not appear within ${GATE_WAIT_MS / 1000} s:\n${agentOut}\n${agentErr}`);
}
words.set(prRun, 'RUN_08');
words.set(gateId, 'GATE_08');
must(
  cli('run', 'respond', prRun, '--gate', gateId, '--choice', 'approve'),
  'realm run respond (08)',
);
const code = await agentExit;
transcript.push({ argv: ['realm', ...shownArgs(agentArgs)], exit: code });
if (code !== 0 || !new RegExp(`^Run complete: ${prRun}$`, 'm').test(agentOut)) {
  stop(`realm agent (08) exited ${code} without finishing the run:\n${agentOut}\n${agentErr}`);
}
must(
  cli('run', 'export', prRun, '--out', path.join(realWork, '08.realm.json')),
  'realm run export (08)',
);
await gh.close();

// The one-step run: no gate, so the agent runs to the end in one call.
must(
  cli('workflow', 'register', path.join(PROJECT, 'one-step.yaml')),
  'realm workflow register (one-step)',
);
const one = must(
  cli(
    'agent',
    '--workflow',
    path.join(PROJECT, 'one-step.yaml'),
    '--params',
    JSON.stringify(NOTE_PARAMS),
    '--provider-module',
    MODULE,
  ),
  'realm agent (one-step)',
);
const noteRun = /^Run ID: ([0-9a-f-]{36})$/m.exec(one.stdout)?.[1];
if (noteRun === undefined || !new RegExp(`^Run complete: ${noteRun}$`, 'm').test(one.stdout)) {
  stop(`realm agent (one-step) did not finish a run:\n${one.stdout}\n${one.stderr}`);
}
words.set(noteRun, 'RUN_ONE_STEP');
must(
  cli('run', 'export', noteRun, '--out', path.join(realWork, 'one-step.realm.json')),
  'realm run export (one-step)',
);

const bundles = {
  '08-pr-review': readJson(path.join(realWork, '08.realm.json')),
  'one-step': readJson(path.join(realWork, 'one-step.realm.json')),
};
for (const [name, bundle] of Object.entries(bundles)) {
  if (!terminal(bundle)) stop(`the ${name} run is not terminal: ${bundle.run?.run_phase}`);
  // A failed attempt's stamp is the host's clock, not the test clock's: none may be recorded.
  if (!Array.isArray(bundle.attempts) || bundle.attempts.length > 0) {
    stop(`the ${name} run recorded failed attempts: ${JSON.stringify(bundle.attempts)}`);
  }
}

// 7. The store, copied as SQLite copies it (VACUUM INTO): a raw copy of a WAL-mode file can miss its
// last transactions.
must(cli('db', 'backup', path.join(realWork, 'realm.db')), 'realm db backup');

// 8. Each example through the published loader.
const definitions = {};
for (const name of examples) {
  const file = path.join(realWork, 'examples', name, 'workflow.yaml');
  const { definition } = loadWorkflowFromFileWithDiagnostics(file);
  const kept = { ...definition };
  for (const key of rules.runtime_only_workflow_keys.values) delete kept[key];
  definitions[name] = kept;
}
fs.mkdirSync(path.join(realWork, 'raw'), { recursive: true });
fs.writeFileSync(
  path.join(realWork, 'raw/definitions.json'),
  JSON.stringify(definitions, null, 2) + '\n',
);

// 9. The rules: WORK → its placeholder, the named keys, then every v4 UUID by first appearance.
function scrub(value) {
  let text = JSON.stringify(value);
  for (const work of new Set([WORK, realWork])) {
    text = text.split(work).join(rules.work_placeholder.value);
  }
  const replaceKeys = (node, parent) => {
    if (Array.isArray(node)) return node.map((item) => replaceKeys(item, parent));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, item] of Object.entries(node)) {
      if (Object.hasOwn(rules.keys.values, key)) out[key] = rules.keys.values[key];
      else if (Object.hasOwn(rules.keys.nested.values, `${parent}.${key}`)) {
        out[key] = rules.keys.nested.values[`${parent}.${key}`];
      } else out[key] = replaceKeys(item, key);
    }
    return out;
  };
  text = JSON.stringify(replaceKeys(JSON.parse(text), ''));
  const seen = new Map();
  text = text.replace(new RegExp(rules.uuid.pattern, 'g'), (id) => {
    if (!seen.has(id)) {
      seen.set(id, rules.uuid.placeholder_prefix + String(seen.size + 1).padStart(12, '0'));
    }
    return seen.get(id);
  });
  return JSON.parse(text);
}
const pretty = (value) => JSON.stringify(value, null, 2) + '\n';

// 10. The corpus folder.
fs.mkdirSync(path.join(CORPUS, 'runs'), { recursive: true });
fs.mkdirSync(path.join(CORPUS, 'project'), { recursive: true });
for (const name of examples) {
  const from = path.join(realWork, 'examples', name);
  const to = path.join(CORPUS, 'examples', name);
  fs.cpSync(from, to, { recursive: true });
  fs.writeFileSync(path.join(to, 'definition.json'), pretty(scrub(definitions[name])));
}
for (const [name, bundle] of Object.entries(bundles)) {
  fs.writeFileSync(path.join(CORPUS, 'runs', `${name}.realm.json`), pretty(scrub(bundle)));
}
fs.writeFileSync(
  path.join(CORPUS, 'realm.db.gz'),
  zlib.gzipSync(fs.readFileSync(path.join(realWork, 'realm.db')), { level: 9 }),
);
fs.writeFileSync(path.join(CORPUS, 'project/realm.yaml'), realmYaml);
fs.writeFileSync(path.join(CORPUS, 'project/stand-in.env'), STAND_IN_ENV);
fs.writeFileSync(
  path.join(CORPUS, 'manifest.json'),
  pretty({
    version,
    integrity,
    recorder_version: RECORDER_VERSION,
    work: WORK,
    work_realpath: realWork,
    start: START,
    github_port: GITHUB_PORT,
    cli_environment: Object.keys(cliEnv),
    drive_environment: Object.keys(driveEnv),
    operator: OPERATOR,
    runs: { '08-pr-review': 'workflow.yaml', 'one-step': 'one-step.yaml' },
    examples,
    rules: 'packages/cli/src/corpus/corpus-rules.json',
    rules_applied: rules,
    transcript,
  }),
);
fs.rmSync(path.join(CORPUS, 'PENDING'), { force: true });
console.log(`recorded ${version} into ${path.relative(REPO, CORPUS)}`);
