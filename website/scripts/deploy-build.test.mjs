// The deploy build (scripts/deploy-build.mjs), on fixture repositories: each test makes its own
// repository with a bare `origin` beside it, no network. A fixture holds this checkout's website/ (its
// tracked and new files, as they are on disk), a few docs pages and a sidebar listing them. Fixtures
// live in website/.deploy-fixtures/ (ignored by git), so they find website/node_modules as a parent
// folder's, as a workspace package does: Astro refuses packages reached through a link. A fixture
// builds without the demo bundle step, so it copies the bundle and its manifest from a plain build:
// run `npm run build` first, as CI's website step does before this.
//
// Run: `npm run test:deploy-build` in website/, after `npm run build`. REALM_KEEP_FIXTURES=1 keeps
// each fixture after its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('REALM_DOCS_') && !k.startsWith('GIT_'),
  ),
);
Object.assign(ENV, {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  // The fixtures do not read this machine's git settings.
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  ASTRO_TELEMETRY_DISABLED: '1',
});
function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...ENV, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function git(cwd, ...args) {
  const r = sh('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) failed:\n${r.out}`);
  return r.out.trim();
}
const REPO = git(WEB, 'rev-parse', '--show-toplevel');
const FIXTURES = path.join(WEB, '.deploy-fixtures');
fs.rmSync(FIXTURES, { recursive: true, force: true });
fs.mkdirSync(FIXTURES);
const made = [];
process.on('exit', () => {
  if (!process.env.REALM_KEEP_FIXTURES)
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const page = (title, description, body = 'Text.') =>
  `# ${title}\n\n<!-- description: ${description} -->\n\n${body}\n`;
const LINES = (n, mark = '') =>
  Array.from({ length: n }, (_, i) => `Line ${i + 1}${mark}.`).join('\n\n');
const BASE_DOCS = {
  'README.md': page(
    'Realm documentation',
    'The fixture docs home.',
    'Read [What is Realm](start/what-is-realm.md).',
  ),
  'start/what-is-realm.md': page('What is Realm', 'What the fixture engine is.'),
  'start/install-and-first-run.md': page(
    'Install and first run',
    'How to install the fixture engine.',
  ),
  'guides/alpha.md': page('Alpha guide', 'The alpha guide.', LINES(8)),
  // The pages llms.txt's own text links to by address: the deploy build refuses a link to a page the
  // release's docs lack, so the fixture's release has each of them.
  'guides/test-a-workflow.md': page('Test a workflow', 'How to test a fixture workflow.'),
  'reference/error-codes.md': page('Error codes', 'The fixture error codes.'),
  'reference/adapters.md': page('Adapters', 'The fixture adapters.'),
  'reference/workflow/step-fields.md': page('Step fields', 'The fixture step fields.'),
};
const BASE_SIDEBAR = [
  { label: 'Start here', items: ['docs/start/what-is-realm', 'docs/start/install-and-first-run'] },
  { label: 'Guides', items: ['docs/guides/alpha', 'docs/guides/test-a-workflow'] },
  {
    label: 'Reference',
    items: [
      'docs/reference/error-codes',
      'docs/reference/adapters',
      'docs/reference/workflow/step-fields',
    ],
  },
];
const V1 = (v) =>
  `These docs describe Realm ${v}, the latest release. Docs for [older versions](https://github.com/sensigo-hq/realm/tags), and for [the next one](https://github.com/sensigo-hq/realm/tree/main/docs), are on GitHub.`;
const V2 =
  "These docs describe Realm as it is on the main branch, not a release. [Each release's docs](https://github.com/sensigo-hq/realm/tags) are on GitHub.";
const X = 'deploy build: dist/ was removed, so nothing from this run can be deployed.';
const S3_TAIL =
  'A fix reaches the live docs by landing on main first, then being copied with git cherry-pick -x and no hand edits; one that cannot be copied cleanly stays off the live docs until the next release. To take this commit off the branch, recreate the branch from the tag and copy the others again, as website/deploy/DEPLOY.md says ("To take a copy back").';
const T = (local, origin) =>
  `deploy build: the local tag v0.10.0 points at ${local.slice(0, 8)}, but origin's points at ${origin.slice(0, 8)}. The release on origin is the one published: delete the local tag with git tag -d v0.10.0 (this build then fetches origin's), then run again.`;
const D2 =
  "deploy build: done, but not for deploying: the site's pages are not origin/main's as they are (see the warning above). Build again from a clean checkout of origin/main.";
const F = 'deploy build: the build failed; its error is printed above.';

function fixture(name) {
  const manifest = path.join(WEB, 'src/live/manifest.json');
  assert.ok(
    fs.existsSync(manifest),
    'run `npm run build` in website/ first: the fixtures copy its demo bundle and manifest',
  );
  const root = fs.mkdtempSync(path.join(FIXTURES, `${name}-`));
  made.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const web = path.join(work, 'website');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  const files = git(
    REPO,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'website',
  )
    .split('\0')
    .filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(REPO, f))) continue; // deleted in this checkout, not yet committed
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(work, f));
  }
  // What a plain build leaves and git ignores: the demo bundle and its manifest.
  fs.copyFileSync(manifest, path.join(web, 'src/live/manifest.json'));
  fs.cpSync(path.join(WEB, 'public/live'), path.join(web, 'public/live'), { recursive: true });
  // The fixture's site builds without the demo bundle step (its guard is checked elsewhere).
  const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
  pkg.scripts.build = 'npm run sync-docs && astro build';
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // Main's packages carry a development version between releases.
  fs.mkdirSync(path.join(work, 'packages/core'), { recursive: true });
  fs.writeFileSync(
    path.join(work, 'packages/core/package.json'),
    '{ "version": "0.10.1-dev.0" }\n',
  );
  const f = {
    root,
    origin,
    work,
    web,
    git: (...a) => git(work, ...a),
    write(rel, text) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), text);
    },
    remove(rel) {
      fs.rmSync(path.join(work, rel));
    },
    edit(rel, from, to) {
      const p = path.join(work, rel);
      const s = fs.readFileSync(p, 'utf8');
      assert.ok(s.includes(from), `${rel} does not contain ${JSON.stringify(from)}`);
      fs.writeFileSync(p, s.replace(from, to));
    },
    // Replaces the lists in the fixture's copy of docs-sidebar.mjs; its code stays as written.
    sidebar(groups, replaced = []) {
      const p = path.join(web, 'src/data/docs-sidebar.mjs');
      let s = fs.readFileSync(p, 'utf8');
      // Written so that the same patterns find them again (each array's "];" on its own line).
      const list = (a) => `[\n${a.map((x) => `  ${JSON.stringify(x)},`).join('\n')}\n]`;
      const before = s;
      s = s.replace(/const SIDEBAR = \[[\s\S]*?\n\];/, `const SIDEBAR = ${list(groups)};`);
      s = s.replace(/const REPLACED = \[[\s\S]*?\n\];/, `const REPLACED = ${list(replaced)};`);
      assert.equal((before.match(/\n\];/g) ?? []).length, (s.match(/\n\];/g) ?? []).length);
      fs.writeFileSync(p, s);
    },
    commit(message) {
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', message);
      return git(work, 'rev-parse', 'HEAD');
    },
    // A plain build's leftover dist/, to show that a stop removes it.
    leftoverDist() {
      fs.mkdirSync(path.join(web, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(web, 'dist/left-by-a-plain-build.html'), 'old');
    },
    hasDist: () => fs.existsSync(path.join(web, 'dist')),
    // Its output and errors in one stream, in the order a terminal shows them.
    deploy: () => sh('sh', ['-c', 'npm run --silent build:deploy 2>&1'], web),
    plain: () => sh('npm', ['run', '--silent', 'build'], web),
    read: (rel) => fs.readFileSync(path.join(web, 'dist', rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(web, 'dist', rel)),
    // Copies main's commits onto the docs branch with cherry-pick -x (extra: more arguments).
    onBranch(version, fn) {
      git(work, 'fetch', '-q', 'origin');
      git(work, 'switch', '-q', '-c', `copy-${Date.now()}`, `origin/docs/v${version}`);
      fn();
      git(work, 'push', '-q', 'origin', `HEAD:refs/heads/docs/v${version}`);
      git(work, 'switch', '-q', 'main');
    },
  };
  for (const [rel, text] of Object.entries(BASE_DOCS)) f.write(`docs/${rel}`, text);
  f.sidebar(BASE_SIDEBAR);
  return f;
}
// A fixture at release 0.10.0: one commit, pushed, tagged; with `cut`, its docs branch too.
function released({ cut = true } = {}) {
  const f = fixture('rel');
  const tag = f.commit('fixture: the site and docs at 0.10.0');
  f.git('push', '-q', 'origin', 'main');
  f.git('tag', 'v0.10.0');
  f.git('push', '-q', 'origin', 'v0.10.0');
  if (cut) f.git('push', '-q', 'origin', 'refs/tags/v0.10.0^0:refs/heads/docs/v0.10.0');
  return { f, tag };
}
// A clone of a fixture's origin (`args`: git clone's options and the address), beside its work tree,
// with the demo bundle a plain build leaves, as a deployer's checkout.
function cloneOf(f, ...args) {
  const work = path.join(f.root, 'clone');
  git(f.root, 'clone', '-q', ...args, 'clone');
  const web = path.join(work, 'website');
  fs.copyFileSync(
    path.join(WEB, 'src/live/manifest.json'),
    path.join(web, 'src/live/manifest.json'),
  );
  fs.cpSync(path.join(WEB, 'public/live'), path.join(web, 'public/live'), { recursive: true });
  return {
    work,
    web,
    git: (...a) => git(work, ...a),
    deploy: () => sh('sh', ['-c', 'npm run --silent build:deploy 2>&1'], web),
    hasDist: () => fs.existsSync(path.join(web, 'dist')),
    leftoverDist() {
      fs.mkdirSync(path.join(web, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(web, 'dist/left-by-a-plain-build.html'), 'old');
    },
  };
}
// The deploy build's own lines (each begins "deploy build: "), and the left-off list's entries.
const own = (out) =>
  out.split('\n').filter((l) => l.startsWith('deploy build: ') || /^ {2}[0-9a-f]{8} /.test(l));
// What a failed check prints: the exit code, the deploy build's lines and, when it failed, the end
// of the build's own output (its error).
const shown = (r) =>
  `exit ${r.code}; the deploy build's lines:\n${own(r.out).join('\n')}` +
  (r.code === 0
    ? ''
    : `\nthe end of its output:\n${r.out
        .split('\n')
        .filter((l) => !/^\s*\S*\s*[├└]─/.test(l))
        .slice(-15)
        .join('\n')}`);
const docsPages = (f) => {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(f.web, 'dist', dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name === 'index.html') out.push(rel);
    }
  })('docs');
  return out;
};

test('1: the newest release is the highest vX.Y.Z on origin, compared as versions; a local-only tag survives; a local tag that differs gives T', () => {
  const f = fixture('newest');
  const a = f.commit('fixture: 0.9.0');
  f.git('tag', 'v0.9.0');
  f.write(
    'docs/start/what-is-realm.md',
    page('What is Realm', 'What the fixture engine is, again.'),
  );
  const b = f.commit('fixture: 0.10.0');
  f.git('tag', 'v0.10.0');
  f.git('push', '-q', 'origin', 'main', 'v0.9.0', 'v0.10.0');
  f.git('tag', 'v0.11.0'); // made locally, not pushed (the release script makes the tag before Part B pushes it)
  f.git('config', 'fetch.pruneTags', 'true'); // a setting that would prune it
  let r = f.deploy();
  // Can fail: tags sorted as text pick 0.9.0; local tags pick 0.11.0; a prune deletes v0.11.0.
  assert.deepEqual(
    own(r.out),
    [
      'deploy build: the newest release is 0.10.0 (tag v0.10.0), but origin has no branch docs/v0.10.0, which the live docs are built from. Cut it from the tag: git push origin refs/tags/v0.10.0^0:refs/heads/docs/v0.10.0',
      X,
    ],
    shown(r),
  );
  assert.equal(
    sh('git', ['rev-parse', '-q', '--verify', 'refs/tags/v0.11.0'], f.work).code,
    0,
    'the local-only tag v0.11.0 was deleted',
  );
  f.git('tag', '-f', 'v0.10.0', a);
  r = f.deploy();
  // Can fail: a local tag that is not compared with origin's.
  assert.deepEqual(own(r.out), [T(a, b), X], shown(r));
  assert.notEqual(r.code, 0, shown(r));
});

test("2: stop 1 (no branch; a branch without the tag) prints its line and X, exits non-zero and leaves no dist/; S1a's command gets the next run past it", () => {
  const { f } = released({ cut: false });
  f.leftoverDist();
  let r = f.deploy();
  const s1a = own(r.out)[0];
  assert.deepEqual(
    own(r.out),
    [
      'deploy build: the newest release is 0.10.0 (tag v0.10.0), but origin has no branch docs/v0.10.0, which the live docs are built from. Cut it from the tag: git push origin refs/tags/v0.10.0^0:refs/heads/docs/v0.10.0',
      X,
    ],
    shown(r),
  );
  assert.notEqual(r.code, 0, shown(r));
  // Can fail: a stop that leaves dist/.
  assert.equal(f.hasDist(), false, `dist/ is still there after S1a. ${shown(r)}`);
  // S1a's own command, run as printed.
  const cmd = s1a.split('Cut it from the tag: ')[1].split(' ');
  assert.equal(cmd[0], 'git', s1a);
  f.git(...cmd.slice(1));
  r = f.deploy();
  assert.equal(r.code, 0, shown(r));
  assert.deepEqual(
    own(r.out).slice(-2),
    [
      'deploy build: every docs commit on main since v0.10.0 is on the site.',
      `deploy build: done. The site's pages are from ${f.git('rev-parse', 'HEAD').slice(0, 8)}, the docs from docs/v0.10.0 at ${f.git('rev-parse', 'origin/docs/v0.10.0').slice(0, 8)} (Realm 0.10.0). Deploy dist/ as website/deploy/DEPLOY.md says.`,
    ],
    shown(r),
  );

  // S1b: the branch is moved to a commit that does not hold the tag.
  f.git('switch', '-q', '--orphan', 'elsewhere');
  f.write('docs/README.md', page('Elsewhere', 'Not the release.'));
  f.commit('fixture: not the release');
  f.git('push', '-q', '--force', 'origin', 'HEAD:refs/heads/docs/v0.10.0');
  f.git('switch', '-q', '-f', 'main');
  f.leftoverDist();
  r = f.deploy();
  assert.deepEqual(
    own(r.out),
    [
      `deploy build: docs/v0.10.0 does not hold the release tag v0.10.0 (${f.git('rev-parse', 'v0.10.0').slice(0, 8)}), so it is not the 0.10.0 docs. Recreate it from the tag, then copy its fixes again with git cherry-pick -x.`,
      X,
    ],
    shown(r),
  );
  assert.notEqual(r.code, 0, shown(r));
  assert.equal(f.hasDist(), false, `dist/ is still there after S1b. ${shown(r)}`);
});

test("3: a build failure prints the build's error, F, then X; origin unreachable prints FF, then X; neither leaves dist/", () => {
  // A page with no description line, in the tagged commit, so no stop 3 line comes with it.
  const f = fixture('fail');
  f.write('docs/guides/alpha.md', '# Alpha guide\n\nNo description line.\n');
  f.commit('fixture: 0.10.0 with a page sync-docs refuses');
  f.git('push', '-q', 'origin', 'main');
  f.git('tag', 'v0.10.0');
  f.git('push', '-q', 'origin', 'v0.10.0', 'refs/tags/v0.10.0^0:refs/heads/docs/v0.10.0');
  f.leftoverDist();
  let r = f.deploy();
  assert.match(
    r.out,
    /sync-docs: 1 problem\(s\) in \.\.\/docs:\n {2}docs\/guides\/alpha\.md: no "<!-- description: ... -->" line/,
    shown(r),
  );
  assert.ok(
    r.out.indexOf('sync-docs: 1 problem') < r.out.indexOf(F),
    "the build's error is not above F",
  );
  assert.deepEqual(own(r.out), [F, X], shown(r));
  assert.notEqual(r.code, 0, shown(r));
  // Can fail: dist/ removed only on the stops.
  assert.equal(f.hasDist(), false, `dist/ is still there after F. ${shown(r)}`);

  // origin's commits cannot be fetched, while its refs can still be listed (a fetch that breaks
  // off): the run stops at the fetch, not with the refs it had.
  const g = released().f;
  const other = path.join(g.root, 'other');
  git(g.root, 'clone', '-q', g.origin, other);
  fs.writeFileSync(
    path.join(other, 'docs/README.md'),
    page('Realm documentation', 'Changed on origin.'),
  );
  git(other, 'commit', '-q', '-am', 'fixture: a commit only origin has');
  git(other, 'push', '-q', 'origin', 'main');
  const lost = git(other, 'rev-parse', 'HEAD');
  fs.rmSync(path.join(g.origin, 'objects', lost.slice(0, 2), lost.slice(2)));
  g.leftoverDist();
  r = g.deploy();
  // Can fail: a failed fetch that goes on with the old refs.
  assert.equal(own(r.out).length, 2, shown(r));
  assert.match(own(r.out)[0], /^deploy build: could not reach origin \(.+\)\.$/, shown(r));
  assert.equal(own(r.out)[1], X, shown(r));
  assert.equal(g.hasDist(), false, `dist/ is still there after FF. ${shown(r)}`);

  // origin's path no longer exists.
  fs.rmSync(g.origin, { recursive: true, force: true });
  g.leftoverDist();
  r = g.deploy();
  assert.deepEqual(
    own(r.out),
    [
      `deploy build: could not reach origin (fatal: '${g.origin}' does not appear to be a git repository).`,
      X,
    ],
    shown(r),
  );
  assert.notEqual(r.code, 0, shown(r));
  assert.equal(g.hasDist(), false, `dist/ is still there after FF. ${shown(r)}`);
});

test('4: stop 3 gives one line per commit that is not a copy, one reason each; a clean copy whose context differs passes', () => {
  const { f } = released();
  // After-release text one line away from the fix below, so the fix's copy has other context.
  f.edit('docs/guides/alpha.md', 'Line 3.', 'Line 3, after the release.');
  f.commit('docs: after-release text on line 3');
  f.edit('docs/guides/alpha.md', 'Line 4.', 'Line 4, fixed.');
  const fix = f.commit('docs: a fix on line 4');
  f.edit('docs/guides/alpha.md', 'Line 8.', 'Line 8, fixed.');
  const edited = f.commit('docs: a fix on line 8');
  f.git('push', '-q', 'origin', 'main');
  // A commit that is on no branch of origin: the copy names it.
  f.git('switch', '-q', '-c', 'side', 'v0.10.0');
  f.edit('docs/start/what-is-realm.md', 'Text.', 'Text from a side branch.');
  const side = f.commit('docs: a side-branch change');
  f.git('switch', '-q', 'main');
  const copies = {};
  f.onBranch('0.10.0', () => {
    f.git('cherry-pick', '-x', fix); // clean; its context (line 3) differs from main's
    copies.clean = f.git('rev-parse', 'HEAD');
    f.edit('docs/start/install-and-first-run.md', 'Text.', 'Text written on the branch.');
    copies.a = f.commit('docs: written on the branch');
    f.git('cherry-pick', '-x', side);
    copies.b = f.git('rev-parse', 'HEAD');
    f.git('cherry-pick', '-x', edited);
    f.edit('docs/guides/alpha.md', 'Line 8, fixed.', 'Line 8, fixed and edited.');
    f.git('add', '-A');
    f.git('commit', '-q', '--amend', '--no-edit');
    copies.c = f.git('rev-parse', 'HEAD');
  });
  const r = f.deploy();
  const tail = S3_TAIL;
  // Can fail: patch-id with context refuses the clean copy; each reason left unchecked lets its commit through.
  assert.deepEqual(
    own(r.out),
    [
      `deploy build: commit ${copies.a.slice(0, 8)} on docs/v0.10.0 ("docs: written on the branch") is not a copy of a commit on main: it has no "(cherry picked from commit …)" line. ${tail}`,
      `deploy build: commit ${copies.b.slice(0, 8)} on docs/v0.10.0 ("docs: a side-branch change") is not a copy of a commit on main: it names ${side.slice(0, 8)}, which is not on main. ${tail}`,
      `deploy build: commit ${copies.c.slice(0, 8)} on docs/v0.10.0 ("docs: a fix on line 8") is not a copy of a commit on main: its change differs from ${edited.slice(0, 8)}'s (edited while copying). ${tail}`,
      X,
    ],
    shown(r),
  );
  assert.notEqual(r.code, 0, shown(r));
  assert.equal(f.hasDist(), false, shown(r));
});

test('5: stop 2 checks every built file and the redirects, in the same run as stop 3', () => {
  const { f } = released();
  f.edit(
    'website/src/pages/index.astro',
    'href="/docs/start/install-and-first-run/">Get started</a>',
    'href="/docs/start/install-and-first-run/">Get started</a>\n      <a href="/docs/guides/gone-home/">Gone</a>\n      <a href="/og/docs-old.png">An address under /og/docs that fits no form</a>',
  );
  fs.appendFileSync(
    path.join(f.work, 'website/deploy/nginx-site.conf'),
    'location = /gone/ { return 301 https://realmengine.dev/docs/guides/gone-nginx/; }\n',
  );
  f.edit(
    'website/src/pages/llms.txt.js',
    "    '## Optional',",
    "    `- [Gone](${absolute(markdownPath('docs/guides/gone-llms'))}): a page the release lacks.`,\n    '',\n    '## Optional',",
  );
  f.write(
    'website/src/pages/examples.astro',
    '---\n---\n<html><body><a href="/docs/guides/gone-page/">Gone</a></body></html>\n',
  );
  f.commit('site: links to pages the release lacks');
  f.git('push', '-q', 'origin', 'main');
  let direct;
  f.onBranch('0.10.0', () => {
    f.edit('docs/guides/alpha.md', 'Line 1.', 'Line 1, written on the branch.');
    direct = f.commit('docs: written on the branch');
  });
  const r = f.deploy();
  const s2 = (file, address) =>
    `deploy build: ${file} sends readers to ${address}, which is not a page in the 0.10.0 docs (docs/v0.10.0). Change it on main, or, if that page is true of 0.10.0, copy its commit onto docs/v0.10.0 with git cherry-pick -x.`;
  // Can fail: links searched for in the source miss the llms.txt link; a fixed list of pages misses
  // examples/; stop 2 run only when stop 3 is clean gives no S2 line.
  assert.deepEqual(
    own(r.out),
    [
      `deploy build: commit ${direct.slice(0, 8)} on docs/v0.10.0 ("docs: written on the branch") is not a copy of a commit on main: it has no "(cherry picked from commit …)" line. ${S3_TAIL}`,
      s2('examples/index.html', '/docs/guides/gone-page/'),
      s2('index.html', '/docs/guides/gone-home/'),
      s2('index.html', '/og/docs-old.png'),
      s2('llms.txt', 'https://realmengine.dev/docs/guides/gone-llms.md'),
      s2('website/deploy/nginx-site.conf', 'https://realmengine.dev/docs/guides/gone-nginx/'),
      X,
    ],
    shown(r),
  );
  assert.notEqual(r.code, 0, shown(r));
  assert.equal(f.hasDist(), false, shown(r));
});

test('6, then 9 and 10 on its build: a page main has and the branch lacks is left off (L2); every docs page carries V1; a plain build after it lists the page and shows V2 (a journey)', () => {
  const { f } = released();
  f.write('docs/guides/newpage.md', page('New page', 'A page added after the release.'));
  f.sidebar([
    BASE_SIDEBAR[0],
    {
      label: 'Guides',
      items: ['docs/guides/alpha', 'docs/guides/test-a-workflow', 'docs/guides/newpage'],
    },
    BASE_SIDEBAR[2],
  ]);
  const added = f.commit('docs: a page added after 0.10.0');
  f.git('push', '-q', 'origin', 'main');
  let r = f.deploy();
  assert.equal(r.code, 0, shown(r));
  assert.deepEqual(
    own(r.out),
    [
      'deploy build: 1 docs commit(s) on main since v0.10.0 are not on the site; copy one onto docs/v0.10.0 with git cherry-pick -x only if it is true of 0.10.0:',
      `  ${added.slice(0, 8)} docs: a page added after 0.10.0`,
      'deploy build: pages on main that are not on the site: docs/guides/newpage.md.',
      `deploy build: done. The site's pages are from ${added.slice(0, 8)}, the docs from docs/v0.10.0 at ${f.git('rev-parse', 'v0.10.0').slice(0, 8)} (Realm 0.10.0). Deploy dist/ as website/deploy/DEPLOY.md says.`,
    ],
    shown(r),
  );
  // Check 6. Can fail: main's sidebar fails the build.
  assert.equal(f.exists('docs/guides/newpage/index.html'), false, 'the page is served');
  assert.equal(f.exists('docs/guides/newpage.md'), false, 'its Markdown copy is served');
  assert.equal(f.read('llms.txt').includes('newpage'), false, 'llms.txt lists it');
  assert.equal(
    f.read('docs/guides/alpha/index.html').includes('/docs/guides/newpage/'),
    false,
    'the sidebar lists it',
  );

  // Check 9: V1 right after each docs page's <h1>, kept out of the search index; first in each copy.
  // Can fail: the version read from a package file; the line inside the indexed text.
  const pages = docsPages(f);
  assert.deepEqual(pages.length, 8, pages.join(', '));
  const html = new RegExp(
    '</h1><p class="docs-version[^"]*" data-pagefind-ignore>These docs describe Realm 0\\.10\\.0, the latest release\\. Docs for <a href="https://github\\.com/sensigo-hq/realm/tags"[^>]*>older versions</a>, and for <a href="https://github\\.com/sensigo-hq/realm/tree/main/docs"[^>]*>the next one</a>, are on GitHub\\.</p>',
  );
  for (const p of pages) assert.match(f.read(p), html, `${p} has no V1 line right after its <h1>`);
  for (const p of pages) {
    const copy = p === 'docs/index.html' ? 'docs.md' : p.replace(/\/index\.html$/, '.md');
    assert.equal(
      f.read(copy).split('\n')[2],
      V1('0.10.0'),
      `${copy}: its first line after the title`,
    );
  }

  // Check 10: the plain build right after it reads main's docs and lists, and says so.
  // Can fail: the branch's lists left in a file a plain build reads ("in no sidebar group").
  r = f.plain();
  assert.equal(r.code, 0, `the plain build failed:\n${r.out.slice(-3000)}`);
  assert.equal(
    f.exists('docs/guides/newpage/index.html'),
    true,
    'the plain build does not serve the page',
  );
  assert.ok(
    f.read('llms.txt').includes('/docs/guides/newpage.md'),
    'the plain build does not list the page',
  );
  for (const p of docsPages(f)) {
    assert.ok(
      f.read(p).includes('These docs describe Realm as it is on the main branch, not a release.'),
      `${p} has no V2 line`,
    );
    assert.ok(!f.read(p).includes('the latest release'), `${p} still says it is a release`);
  }
  assert.equal(f.read('docs/guides/newpage.md').split('\n')[2], V2);
});

test('7: a page the branch has and main deleted is served and listed as the branch lists it', () => {
  const { f } = released();
  f.remove('docs/guides/alpha.md');
  f.sidebar([BASE_SIDEBAR[0]]);
  f.commit('docs: alpha removed after 0.10.0');
  f.git('push', '-q', 'origin', 'main');
  const r = f.deploy();
  // Can fail: main's sidebar ("in no sidebar group").
  assert.equal(r.code, 0, shown(r) + '\n' + r.out.slice(-2000));
  assert.equal(f.exists('docs/guides/alpha/index.html'), true, 'the page is not served');
  assert.ok(f.read('llms.txt').includes('/docs/guides/alpha.md'), 'llms.txt does not list it');
  assert.ok(
    f.read('docs/start/what-is-realm/index.html').includes('href="/docs/guides/alpha/"'),
    'the sidebar does not list it',
  );
});

test("8: the left-off list names main's docs commits that no branch commit names, by commit; with every one copied, L0", () => {
  const { f } = released();
  f.edit('docs/guides/alpha.md', 'Line 1.', 'Line 1, fixed.');
  const one = f.commit('docs: fix one');
  f.edit('docs/guides/alpha.md', 'Line 6.', 'Line 6, fixed.');
  const two = f.commit('docs: fix two');
  f.git('push', '-q', 'origin', 'main');
  f.onBranch('0.10.0', () => {
    // The copy's subject is reworded (cherry-pick -x -e); its "(cherry picked …)" line still names it.
    const r = sh('git', ['cherry-pick', '-x', '-e', one], f.work, {
      GIT_EDITOR: `node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/^docs: fix one/,'docs: fix one, copied for 0.10.0'))"`,
    });
    assert.equal(r.code, 0, r.out);
  });
  assert.match(f.git('log', '-1', '--format=%s', 'origin/docs/v0.10.0'), /copied for 0\.10\.0/);
  let r = f.deploy();
  // Can fail: matching by subject lists the reworded copy's original.
  assert.equal(r.code, 0, shown(r));
  assert.deepEqual(
    own(r.out).slice(0, 2),
    [
      'deploy build: 1 docs commit(s) on main since v0.10.0 are not on the site; copy one onto docs/v0.10.0 with git cherry-pick -x only if it is true of 0.10.0:',
      `  ${two.slice(0, 8)} docs: fix two`,
    ],
    shown(r),
  );
  f.onBranch('0.10.0', () => f.git('cherry-pick', '-x', two));
  r = f.deploy();
  assert.equal(r.code, 0, shown(r));
  assert.equal(
    own(r.out)[0],
    'deploy build: every docs commit on main since v0.10.0 is on the site.',
    shown(r),
  );
});

test('10: a plain build is unchanged: a docs page in no sidebar group still fails it', () => {
  const { f } = released();
  f.write('docs/guides/unlisted.md', page('Unlisted', 'A page nobody put in the sidebar.'));
  // Can fail: the plain build no longer checks the sidebar.
  const r = f.plain();
  assert.notEqual(r.code, 0, 'the plain build passed with an unlisted page');
  assert.match(
    r.out,
    /docs\/guides\/unlisted: in no sidebar group \(src\/data\/docs-sidebar\.mjs\)/,
    r.out.slice(-3000),
  );
});

test("11: line W when the site's pages are not origin/main as it is, then D2 in place of D", () => {
  const { f, tag } = released();
  const W = (head, dirty) =>
    `deploy build: warning: the site's pages are from ${head.slice(0, 8)}${dirty ? ', with uncommitted changes' : ''}, not origin/main (${tag.slice(0, 8)}). A deploy should be built from origin/main with no changes.`;
  f.write('local.txt', 'a local change');
  const local = f.commit('site: a local commit, not pushed');
  // Can fail: no W; D after W (a build the warning fired on, called done for deploying).
  let r = f.deploy();
  assert.equal(r.code, 0, shown(r));
  assert.deepEqual(own(r.out).slice(-2), [W(local, false), D2], shown(r));
  f.write('notes.txt', 'an untracked file');
  r = f.deploy();
  assert.deepEqual(own(r.out).slice(-2), [W(local, true), D2], shown(r));
  assert.equal(r.code, 0, shown(r));
  f.git('reset', '-q', '--hard', 'origin/main');
  r = f.deploy();
  assert.deepEqual(
    own(r.out).slice(-2),
    [
      `deploy build: warning: the site's pages are from ${tag.slice(0, 8)}, with uncommitted changes. A deploy should be built from origin/main with no changes.`,
      D2,
    ],
    shown(r),
  );
  assert.equal(r.code, 0, shown(r));
});

test('Behaviour 10: an interrupt during the build leaves no dist/ and prints X', async () => {
  const { f } = released();
  const child = spawn('node', ['scripts/deploy-build.mjs'], { cwd: f.web, env: ENV });
  let out = '';
  const interrupted = new Promise((resolve) => {
    const seen = (b) => {
      out += b;
      // Astro has started writing dist/.
      if (/Building static entrypoints|generating static routes/.test(out) && !child.killed) {
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const end = await interrupted;
  const lines = own(out);
  // Can fail: an interrupt that leaves dist/ (no handler, or one that removes it before the build
  // stops writing).
  assert.equal(end.code, 143, `exit ${end.code} ${end.signal}; ${lines.join(' | ')}`);
  assert.equal(lines.at(-1), X, lines.join('\n'));
  assert.equal(f.hasDist(), false, `dist/ is still there after SIGTERM: ${lines.join(' | ')}`);
});

test('C1-1: a single-branch clone builds as a full clone does: the docs branch is looked up on origin', () => {
  const { f } = released();
  f.edit('docs/guides/alpha.md', 'Line 2.', 'Line 2, fixed.');
  const fix = f.commit('docs: a fix');
  f.git('push', '-q', 'origin', 'main');
  f.onBranch('0.10.0', () => f.git('cherry-pick', '-x', fix));
  const c = cloneOf(f, '--single-branch', '--branch', 'main', f.origin);
  assert.equal(
    c.git('config', '--get-all', 'remote.origin.fetch'),
    '+refs/heads/main:refs/remotes/origin/main',
  );
  const r = c.deploy();
  // Can fail: the branch read from the clone's own refs ("origin has no branch docs/v0.10.0").
  assert.equal(r.code, 0, shown(r));
  assert.deepEqual(
    own(r.out),
    [
      'deploy build: every docs commit on main since v0.10.0 is on the site.',
      `deploy build: done. The site's pages are from ${fix.slice(0, 8)}, the docs from docs/v0.10.0 at ${f.git('rev-parse', 'origin/docs/v0.10.0').slice(0, 8)} (Realm 0.10.0). Deploy dist/ as website/deploy/DEPLOY.md says.`,
    ],
    shown(r),
  );
});

test('C1-1b: a shallow clone stops first, with the command that deepens it, and leaves no dist/', () => {
  const { f } = released();
  const c = cloneOf(f, '--depth', '1', `file://${f.origin}`);
  assert.equal(c.git('rev-parse', '--is-shallow-repository'), 'true');
  c.leftoverDist();
  const r = c.deploy();
  // Can fail: no shallow check.
  assert.deepEqual(
    own(r.out),
    [
      "deploy build: this clone is shallow, so the docs branch cannot be checked against main's history. Run git fetch --unshallow origin, then run again.",
      X,
    ],
    shown(r),
  );
  assert.equal(r.code, 1, shown(r));
  assert.equal(c.hasDist(), false, `dist/ is still there. ${shown(r)}`);
});

test('C1-2: Ctrl-C during the fetch is an interrupt: X, exit 130, no dist/, no "could not reach origin"', async () => {
  const { f } = released();
  // origin answers slowly, so the fetch is still running when the terminal sends Ctrl-C.
  const marker = path.join(f.root, 'upload-pack-started');
  const slow = path.join(f.root, 'slow-upload-pack.sh');
  fs.writeFileSync(slow, `#!/bin/sh\ntouch '${marker}'\nsleep 20\nexec git-upload-pack "$@"\n`, {
    mode: 0o755,
  });
  f.git('config', 'remote.origin.uploadpack', slow);
  f.leftoverDist();
  // A terminal sends Ctrl-C to the whole foreground process group: the build and its git call.
  const child = spawn('node', ['scripts/deploy-build.mjs'], {
    cwd: f.web,
    env: ENV,
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  const ended = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(marker), 'the fetch never reached origin');
  process.kill(-child.pid, 'SIGINT');
  const end = await ended;
  const lines = own(out);
  // Can fail: the interrupted fetch read as a failed one ("could not reach origin").
  assert.deepEqual(lines, [X], `exit ${end.code} ${end.signal}; ${lines.join(' | ')}`);
  assert.equal(end.code, 130, `exit ${end.code} ${end.signal}; ${lines.join(' | ')}`);
  assert.equal(f.hasDist(), false, `dist/ is still there: ${lines.join(' | ')}`);
});

test("C1-3: the T line's own advice (git tag -d, run again) gets the build through", () => {
  const { f, tag } = released();
  f.write('local.txt', 'a commit the local tag will point at');
  const other = f.commit('fixture: elsewhere');
  f.git('tag', '-f', 'v0.10.0', other);
  f.git('reset', '-q', '--hard', 'origin/main');
  let r = f.deploy();
  // Can fail: the old T line, which gave no command.
  assert.deepEqual(own(r.out), [T(other, tag), X], shown(r));
  f.git('tag', '-d', 'v0.10.0');
  r = f.deploy();
  assert.equal(r.code, 0, shown(r));
  assert.match(own(r.out).at(-1), /^deploy build: done\. The site's pages are from /, shown(r));
  assert.equal(f.git('rev-parse', 'v0.10.0'), tag, "the build did not fetch origin's tag");
});
