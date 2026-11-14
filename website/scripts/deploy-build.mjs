// The deploy build of realmengine.dev: `npm run build:deploy` in website/. How to deploy with it:
// website/deploy/DEPLOY.md.
//
// The site's own pages (home, demo, /compare/, how-it-works, llms.txt's prose) come from this checkout;
// the docs come from the newest release's branch docs/v<version>, cut from the release tag, so the live
// docs describe the release people install. A docs fix that is true of the release lands on main first
// and is copied onto that branch with `git cherry-pick -x`. Three things stop the build, with nothing
// left in dist/:
//   stop 1: origin has no branch docs/v<newest release>, or it does not hold the release tag;
//   stop 2: a site file sends readers to a docs page the branch lacks;
//   stop 3: a commit on the branch is not a copy of a commit on main.
// A finished build lists the docs commits on main that stay off the site. Plain builds (`npm run
// build`, CI, `npm run dev`) are unchanged: they read the checkout's docs/.
//
// The branch's docs, its sidebar lists and its version reach the build only through the environment
// of the `npm run build` this starts (REALM_DOCS_SRC, REALM_DOCS_LISTS, REALM_DOCS_VERSION); nothing
// is written where a later plain build would read it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEBSITE, 'dist');
const STEPS_FILE = 'website/deploy/DEPLOY.md';
const SIDEBAR_FILE = 'website/src/data/docs-sidebar.mjs';
const NGINX_FILE = 'website/deploy/nginx-site.conf';
const SITE = 'https://realmengine.dev';
const MAIN = 'refs/remotes/origin/main';
// A remote call never waits for a password prompt; it fails and says why.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const say = (s) => console.log(`deploy build: ${s}`);
// The exit code of an interrupt, by signal.
const INTERRUPT = { SIGINT: 130, SIGTERM: 143 };
const short = (sha) => sha.slice(0, 8);
const X = 'dist/ was removed, so nothing from this run can be deployed.';

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: WEBSITE, encoding: 'utf8' });
if (top.status !== 0) {
  say(`not in a git checkout (${(top.stderr || '').trim()}).`);
  process.exit(1);
}
const ROOT = top.stdout.trim();

// A call that Ctrl-C or SIGTERM ended is an interrupt: the run stops as one (X, 130 or 143), not as
// a failure of the call ("could not reach origin", "the build failed").
function stopIfInterrupted(r) {
  if (r.signal in INTERRUPT) stop([], INTERRUPT[r.signal]);
}
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    env: GIT_ENV,
    encoding: opts.encoding === null ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input: opts.input,
  });
  stopIfInterrupted(r);
  return { ok: r.status === 0, out: r.stdout ?? '', err: String(r.stderr ?? '') };
}
const revParse = (ref) => {
  const r = git(['rev-parse', '-q', '--verify', ref]);
  return r.ok ? r.out.trim() : null;
};
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).ok;
const firstErrorLine = (err) => {
  const lines = err
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? 'git gave no message';
};

let child = null;
let tmp = null;
const removeDist = () => fs.rmSync(DIST, { recursive: true, force: true });
const removeTmp = () => tmp && fs.rmSync(tmp, { recursive: true, force: true });

// Every exit that is not a success leaves no dist/: the lines, then X.
function stop(lines, code = 1) {
  removeDist();
  removeTmp();
  for (const l of lines) say(l);
  say(X);
  process.exit(code);
}

// An interrupt (Ctrl-C, SIGTERM) also leaves no dist/. The build runs in its own process group, so it
// is stopped as a whole, and dist/ is removed once it has stopped writing.
for (const [sig, code] of Object.entries(INTERRUPT)) {
  process.on(sig, () => {
    if (!child) return stop([], code);
    const done = () => stop([], code);
    child.once('exit', done);
    setTimeout(done, 10000).unref();
    try {
      process.kill(-child.pid, sig);
    } catch {
      done();
    }
  });
}

// 1. Start clean: a plain build or an earlier run leaves a dist/ behind.
removeDist();

// A shallow clone has no history to check the docs branch's copies against.
if (git(['rev-parse', '--is-shallow-repository']).out.trim() === 'true')
  stop([
    "this clone is shallow, so the docs branch cannot be checked against main's history. Run git fetch --unshallow origin, then run again.",
  ]);

// 2. Fetch origin's branches. A branch deleted on origin goes locally too; tags are never pruned, so a
// release tag made locally and not yet pushed survives (whatever fetch.pruneTags says).
const fetched = git(['fetch', '--prune', '--no-prune-tags', 'origin']);
if (!fetched.ok) stop([`could not reach origin (${firstErrorLine(fetched.err)}).`]);

// 3. The newest release: the highest vX.Y.Z tag on origin itself, compared as versions. Its docs
// branch is looked up on origin too: a single-branch clone fetches only main.
const listed = git(['ls-remote', '--refs', 'origin']);
if (!listed.ok) stop([`could not reach origin (${firstErrorLine(listed.err)}).`]);
const releases = listed.out
  .split('\n')
  .map((l) => /^([0-9a-f]+)\trefs\/tags\/v(\d+)\.(\d+)\.(\d+)$/.exec(l.trim()))
  .filter(Boolean)
  .map((m) => ({ sha: m[1], parts: [+m[2], +m[3], +m[4]] }))
  .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
if (releases.length === 0)
  stop(['origin has no release tag (vX.Y.Z), so there is no release to build the docs from.']);
const VERSION = releases[0].parts.join('.');
const TAG = `v${VERSION}`;
const BRANCH = `docs/${TAG}`;
const BRANCH_REF = `refs/remotes/origin/${BRANCH}`;

// The local tag must point where origin's does; a missing one is fetched.
let localTag = revParse(`refs/tags/${TAG}`);
if (!localTag) {
  const got = git(['fetch', '--no-tags', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`]);
  if (!got.ok) stop([`could not reach origin (${firstErrorLine(got.err)}).`]);
  localTag = revParse(`refs/tags/${TAG}`);
}
if (localTag !== releases[0].sha)
  stop([
    `the local tag ${TAG} points at ${short(localTag ?? '(nothing)')}, but origin's points at ${short(releases[0].sha)}. The release on origin is the one published: delete the local tag with git tag -d ${TAG} (this build then fetches origin's), then run again.`,
  ]);
const TAG_COMMIT = revParse(`refs/tags/${TAG}^{commit}`);

// 4. Stop 1: the branch must exist on origin and hold the release. The branch and main are fetched
// by name, so a single-branch clone has both.
if (!listed.out.split('\n').some((l) => l.trim().endsWith(`\trefs/heads/${BRANCH}`)))
  stop([
    `the newest release is ${VERSION} (tag ${TAG}), but origin has no branch ${BRANCH}, which the live docs are built from. Cut it from the tag: git push origin refs/tags/${TAG}^0:refs/heads/${BRANCH}`,
  ]);
const both = git([
  'fetch',
  '--no-tags',
  'origin',
  `+refs/heads/main:${MAIN}`,
  `+refs/heads/${BRANCH}:${BRANCH_REF}`,
]);
if (!both.ok) stop([`could not reach origin (${firstErrorLine(both.err)}).`]);
const BRANCH_SHA = revParse(BRANCH_REF);
if (!isAncestor(TAG_COMMIT, BRANCH_SHA))
  stop([
    `${BRANCH} does not hold the release tag ${TAG} (${short(TAG_COMMIT)}), so it is not the ${VERSION} docs. Recreate it from the tag, then copy its fixes again with git cherry-pick -x.`,
  ]);

// 5. Stop 3, collected: every commit on the branch past the tag must be a copy of a commit on main.
// "A copy" is `cherry-pick -x` with no hand edits: the same files, and in each the same lines removed
// and added in the same order (a -U0 comparison: line numbers and context lines aside, so a clean
// copy whose context differs still passes).
const change = (sha) =>
  git(['show', '-U0', '--format=', '--no-color', '--no-ext-diff', '--no-renames', sha])
    .out.split('\n')
    .filter((l) => l.startsWith('diff --git ') || l.startsWith('+') || l.startsWith('-'))
    .join('\n');
const s3 = [];
const named = []; // every commit a branch commit names in its "(cherry picked from commit …)" line
for (const sha of git(['rev-list', '--reverse', `${TAG_COMMIT}..${BRANCH_SHA}`])
  .out.split('\n')
  .filter(Boolean)) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).out.trim().split(' ').length - 1;
  const subject = git(['log', '-1', '--format=%s', sha]).out.trim();
  const names = [
    ...git(['log', '-1', '--format=%B', sha]).out.matchAll(
      /\(cherry picked from commit ([0-9a-f]{7,40})\)/g,
    ),
  ].map((m) => m[1]);
  const resolved = names.map((n) => revParse(`${n}^{commit}`) ?? n);
  named.push(...resolved);
  let reason = null;
  if (names.length === 0) reason = 'it has no "(cherry picked from commit …)" line';
  else {
    const source = resolved.at(-1);
    if (!revParse(`${source}^{commit}`) || !isAncestor(source, MAIN))
      reason = `it names ${short(source)}, which is not on main`;
    // A merge is never a copy.
    else if (parents !== 1 || change(sha) !== change(source))
      reason = `its change differs from ${short(source)}'s (edited while copying)`;
  }
  if (reason)
    s3.push(
      `commit ${short(sha)} on ${BRANCH} ("${subject}") is not a copy of a commit on main: ${reason}. A fix reaches the live docs by landing on main first, then being copied with git cherry-pick -x and no hand edits; one that cannot be copied cleanly stays off the live docs until the next release. To take this commit off the branch, recreate the branch from the tag and copy the others again, as ${STEPS_FILE} says ("To take a copy back").`,
    );
}

// 6. Build: the site's pages from the checkout, the docs and their lists from the branch.
const F = 'the build failed; its error is printed above.';
tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-deploy-docs-'));
let lists;
try {
  const archive = spawnSync('git', ['archive', '--format=tar', BRANCH_SHA, 'docs'], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  stopIfInterrupted(archive);
  if (archive.status !== 0) throw new Error(`git archive: ${String(archive.stderr).trim()}`);
  const untar = spawnSync('tar', ['-x', '-C', tmp], { input: archive.stdout });
  stopIfInterrupted(untar);
  if (untar.status !== 0) throw new Error(`tar: ${String(untar.stderr).trim()}`);
  const sidebar = git(['show', `${BRANCH_SHA}:${SIDEBAR_FILE}`]);
  if (!sidebar.ok) throw new Error(`${BRANCH} has no ${SIDEBAR_FILE}`);
  fs.writeFileSync(path.join(tmp, 'docs-sidebar.mjs'), sidebar.out);
  // The branch's module, with no lists handed to it, gives its own.
  delete process.env.REALM_DOCS_LISTS;
  const m = await import(pathToFileURL(path.join(tmp, 'docs-sidebar.mjs')).href);
  lists = {
    sidebar: m.DOCS_SIDEBAR,
    indexId: m.DOCS_INDEX_ID,
    replaced: m.REPLACED_PAGE_IDS ?? [],
  };
} catch (e) {
  console.error(e?.message ?? e);
  stop([F, ...s3]);
}
const built = await new Promise((resolve) => {
  child = spawn('npm', ['run', 'build'], {
    cwd: WEBSITE,
    stdio: 'inherit',
    detached: true,
    env: {
      ...process.env,
      REALM_DOCS_SRC: path.join(tmp, 'docs'),
      REALM_DOCS_LISTS: JSON.stringify(lists),
      REALM_DOCS_VERSION: VERSION,
    },
  });
  child.on('error', (e) => {
    console.error(e.message);
    resolve(1);
  });
  child.on('exit', (code) => resolve(code ?? 1));
});
child = null;
if (built !== 0) stop([F, ...s3]);

// 7. Stop 2, collected: every address into the docs must be a page in the built docs. Checked: every
// built file except each docs page's own text, the docs pages' Markdown copies and their preview
// images; and every redirect target in the nginx rules.
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(DIST, p).split(path.sep).join('/'));
  }
})(DIST);
const pages = new Set(
  files
    .filter((f) => f === 'docs/index.html' || (f.startsWith('docs/') && f.endsWith('/index.html')))
    .map((f) => f.replace(/\/index\.html$/, '')),
);
const TEXT = /\.(html|txt|md|xml|js|mjs|css|json|webmanifest|svg)$/;
const isDocsPage = (f) => f === 'docs/index.html' || (f.startsWith('docs/') && f.endsWith('.html'));
const isDocsCopy = (f) => f === 'docs.md' || (f.startsWith('docs/') && f.endsWith('.md'));
const isDocsImage = (f) => f === 'og/docs.png' || f.startsWith('og/docs/');

// The element that starts at `i` (an opening tag), through its matching closing tag.
function elementAt(html, i) {
  const name = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i))?.[1];
  if (!name) return null;
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, 'g');
  tag.lastIndex = i;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return [i, m.index + m[0].length];
  }
  return [i, html.length];
}
// Cuts out the first element whose opening tag matches `open`; returns [the rest, the element].
function cut(html, open) {
  const m = open.exec(html);
  if (!m) return [html, ''];
  const [a, b] = elementAt(html, m.index);
  return [html.slice(0, a) + html.slice(b), html.slice(a, b)];
}

// `&amp;` last, so "&amp;quot;" stays the text "&quot;" (decoding it first would decode twice).
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
// The addresses in a text: href values, Markdown links, and full https://realmengine.dev/… addresses.
function addresses(text) {
  const out = [];
  for (const m of text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out.push(decode(m[1] ?? m[2]));
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/https:\/\/realmengine\.dev(?:\/[^\s"'<>)\]\\]*)?/g))
    out.push(m[0]);
  return out;
}
// The site path an address names, from the file `from` (a built path), or null when it is elsewhere.
function sitePath(address, from) {
  if (/^(#|mailto:|tel:|javascript:|data:)/i.test(address)) return null;
  let url;
  try {
    url = new URL(address, `${SITE}/${from}`);
  } catch {
    return null;
  }
  return url.origin === SITE ? url.pathname : null;
}
// Which docs page a site path names: a page id, '' for an address under /docs/, /docs.md or /og/docs
// that fits no form, or null for a path outside the docs.
function docsPageOf(p) {
  if (p === '/docs/' || p === '/docs.md' || p === '/og/docs.png') return lists.indexId;
  if (!(p.startsWith('/docs/') || p.startsWith('/og/docs'))) return null;
  const m =
    /^\/docs\/(.+)\/$/.exec(p) ?? /^\/docs\/(.+)\.md$/.exec(p) ?? /^\/og\/docs\/(.+)\.png$/.exec(p);
  return m ? `docs/${m[1]}` : '';
}
const s2 = [];
const seen = new Set();
function check(file, address, from) {
  const p = sitePath(address, from);
  if (p === null) return;
  const id = docsPageOf(p);
  if (id === null || pages.has(id)) return;
  const shown = address.split('#')[0].split('?')[0];
  const key = `${file}\n${shown}`;
  if (seen.has(key)) return;
  seen.add(key);
  s2.push(
    `${file} sends readers to ${shown}, which is not a page in the ${VERSION} docs (${BRANCH}). Change it on main, or, if that page is true of ${VERSION}, copy its commit onto ${BRANCH} with git cherry-pick -x.`,
  );
}
const HEADER = "the docs pages' header";
for (const f of files.sort()) {
  if (!TEXT.test(f) || isDocsCopy(f) || isDocsImage(f)) continue;
  let text = fs.readFileSync(path.join(DIST, f), 'utf8');
  if (isDocsPage(f)) {
    // The page's own text is the branch's, as written for the release: not checked here.
    [text] = cut(text, /<div class="sl-markdown-content">/);
    // The header and the phone menu's links are the same on every docs page: named once.
    let header, menu;
    [text, header] = cut(text, /<header\b[^>]*\bclass="header\b/);
    [text, menu] = cut(text, /<div class="menu-bottom\b/);
    for (const a of addresses(header + menu)) check(HEADER, a, f);
  }
  for (const a of addresses(text)) check(f, a, f);
}
const nginx = fs.readFileSync(path.join(ROOT, NGINX_FILE), 'utf8');
for (const m of nginx.matchAll(/\breturn\s+301\s+([^\s;]+)\s*;/g)) check(NGINX_FILE, m[1], '');

// 8. Any stop 2 or stop 3 problem: all of them, stop 3 first.
if (s3.length || s2.length) stop([...s3, ...s2]);

// 9. Success. First the docs commits on main since the tag that are not on the site.
const copied = (sha) => named.some((n) => sha.startsWith(n) || n.startsWith(sha));
const leftOff = git([
  'log',
  '--no-merges',
  '--reverse',
  '--format=%H%x09%s',
  `${TAG_COMMIT}..${MAIN}`,
  '--',
  'docs',
  SIDEBAR_FILE,
])
  .out.split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'))
  .filter(([sha]) => !copied(sha));
const docsFiles = (ref) =>
  git(['ls-tree', '-r', '--name-only', ref, '--', 'docs'])
    .out.split('\n')
    .filter((f) => f.endsWith('.md'));
const onBranch = new Set(docsFiles(BRANCH_SHA));
const missing = docsFiles(MAIN).filter((f) => !onBranch.has(f));
if (leftOff.length) {
  say(
    `${leftOff.length} docs commit(s) on main since ${TAG} are not on the site; copy one onto ${BRANCH} with git cherry-pick -x only if it is true of ${VERSION}:`,
  );
  for (const [sha, subject] of leftOff) console.log(`  ${short(sha)} ${subject}`);
}
if (missing.length) say(`pages on main that are not on the site: ${missing.join(', ')}.`);
if (!leftOff.length && !missing.length)
  say(`every docs commit on main since ${TAG} is on the site.`);

// Then a warning when the site's pages are not origin/main's, as they are.
const HEAD = revParse('HEAD');
const MAIN_SHA = revParse(MAIN);
const dirty = git(['status', '--porcelain']).out.trim() !== '';
if (HEAD !== MAIN_SHA)
  say(
    `warning: the site's pages are from ${short(HEAD)}${dirty ? ', with uncommitted changes' : ''}, not origin/main (${short(MAIN_SHA)}). A deploy should be built from origin/main with no changes.`,
  );
else if (dirty)
  say(
    `warning: the site's pages are from ${short(HEAD)}, with uncommitted changes. A deploy should be built from origin/main with no changes.`,
  );

removeTmp();
// A build the warning fired on is not one to deploy, and the last line says so.
if (HEAD !== MAIN_SHA || dirty)
  say(
    "done, but not for deploying: the site's pages are not origin/main's as they are (see the warning above). Build again from a clean checkout of origin/main.",
  );
else
  say(
    `done. The site's pages are from ${short(HEAD)}, the docs from ${BRANCH} at ${short(BRANCH_SHA)} (Realm ${VERSION}). Deploy dist/ as ${STEPS_FILE} says.`,
  );
