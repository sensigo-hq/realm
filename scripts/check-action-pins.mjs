#!/usr/bin/env node
// issue #326 — the action-pin truth guard.
//
// Every `uses:` line in .github/workflows/*.{yml,yaml} pins a GitHub Action to a full 40-hex
// commit SHA with a trailing `# vX.Y.Z…` comment naming the tag that SHA is supposed to BE. That
// comment is documentation, not verification — nothing has ever checked it agrees with reality.
// Provenance (the live defect this kills): Dependabot PR #315 moved scorecard.yml's codeql-action
// pin to the v4.37.6 commit while its PRESERVED comment still claimed `# v4.37.3`, and left
// sibling pins of the same action at a different, older SHA entirely — caught only by an
// architect manually resolving and peeling tags via the GitHub API. This script makes that catch
// automatic: it re-derives what each pinned SHA is *supposed* to be from the live tag the comment
// names, and fails loudly on any disagreement, imprecision, or cross-file non-uniformity.
//
// House pattern (mirrors scripts/check-audit-allowlist.mjs): a heavily-commented, zero-surprise
// `.mjs`, run as a bare `node scripts/…` step in both the PR gate (ci.yml) and the weekly
// scheduled audit (scheduled-audit.yml) — the weekly clock is what catches an upstream tag
// re-point that happens *between* PRs, when nothing here changed at all. No test file: this
// script's own correctness is proven by the fixture-probe transcripts in its implementation
// report, not by a suite.
//
// PARSING IS DELIBERATELY LINE-BASED, NOT A REAL YAML PARSE: a real parser discards comments, and
// the comment is the exact thing under verification here. The anchor is `uses:` in KEY position.
// A real step writes this key one of two ways — `- uses: owner/repo@sha # vX` (single-line
// sequence-item form) or `- name: …` followed by `  uses: owner/repo@sha # vX` on its own line
// (two-line form, no leading dash) — so the trimmed line must start with `uses:` EITHER directly
// OR after stripping a single leading `-` sequence-item marker and its following whitespace.
// Either way this is never a bare substring match, which would also catch a
// `run: echo "uses: foo"` step and misparse it as an action reference.
//
// ZERO NPM DEPENDENCIES: only Node 24 built-ins (`fetch`, `fs`, `path`). Both wired jobs already
// pin `node-version: '24'`. This lets the step run BEFORE `npm ci` (see ci.yml/scheduled-audit.yml
// for the placement rationale) — a red pin finding costs nothing to detect; there's no reason to
// pay for a dependency install first.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEFAULT_WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const PRECISE_VERSION_PATTERN = /^v\d+\.\d+\.\d+/;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * `--dir <workflows-dir>` (default `.github/workflows`), `--resolver-fixture <json>` (offline
 * mode — see `loadFixtureResolver` below), `--retry-delay-ms <n>` (live-mode-only backoff base;
 * IGNORED in fixture mode, which always uses zero delay — see `main()` — so probe transcripts
 * never sleep through real backoffs).
 */
function parseArgs(argv) {
  const args = { dir: DEFAULT_WORKFLOWS_DIR, resolverFixture: undefined, retryDelayMs: 500 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      args.dir = argv[++i];
    } else if (argv[i] === '--resolver-fixture') {
      args.resolverFixture = argv[++i];
    } else if (argv[i] === '--retry-delay-ms') {
      args.retryDelayMs = Number(argv[++i]);
    } else {
      throw new Error(`unrecognized argument: '${argv[i]}'`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Parsing: extract every `uses:` entry from a workflow file's raw text
// ---------------------------------------------------------------------------

/**
 * One parsed `uses:` line. `refExpr` is everything between `uses:` and the trailing `#` comment
 * (if any) — e.g. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`. `comment` is the
 * trimmed text after the FIRST `#` on the line (undefined if there is none) — trailing
 * parentheticals after the version token, e.g. `(reuse codeql.yml's pin)`, live inside this
 * string and are never stripped; only the comment's own FIRST whitespace-delimited token is
 * tested against `PRECISE_VERSION_PATTERN`.
 */
function extractUsesEntries(fileContent, filePath) {
  const lines = fileContent.split('\n');
  const entries = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trimStart();
    // Strip an optional leading `-` sequence-item marker (`- uses: …`) before anchoring on the
    // KEY-POSITION `uses:` prefix — a nested `uses:` under a preceding `- name:` line has no dash
    // of its own. Still never a bare substring test: a `run:` line starts with `run:`, not `-` or
    // `uses:`, so it can never reach the key-position check below.
    const afterDash = trimmed.startsWith('-') ? trimmed.slice(1).trimStart() : trimmed;
    if (!afterDash.startsWith('uses:')) return;
    const afterKey = afterDash.slice('uses:'.length).trim();
    const hashIdx = afterKey.indexOf('#');
    const refExpr = (hashIdx === -1 ? afterKey : afterKey.slice(0, hashIdx)).trim();
    const comment = hashIdx === -1 ? undefined : afterKey.slice(hashIdx + 1).trim();
    entries.push({ file: filePath, lineNumber: idx + 1, raw: line, refExpr, comment });
  });
  return entries;
}

/**
 * Splits `owner/repo[/subpath]@ref` into its parts. `repoBase` is always exactly the first two
 * `/`-separated segments — issue #326's rule 3: a subpath use like `github/codeql-action/init`
 * resolves (and NON_UNIFORM-groups) against the ROOT repo `github/codeql-action`, never its own
 * subpath string.
 */
function splitRefExpr(refExpr) {
  const atIdx = refExpr.lastIndexOf('@');
  if (atIdx === -1) return { repoWithPath: refExpr, ref: undefined };
  const repoWithPath = refExpr.slice(0, atIdx);
  const ref = refExpr.slice(atIdx + 1);
  const segments = repoWithPath.split('/');
  const repoBase = segments.slice(0, 2).join('/');
  return { repoWithPath, repoBase, ref };
}

// ---------------------------------------------------------------------------
// Resolvers — live (GitHub API) and fixture (offline, deterministic)
// ---------------------------------------------------------------------------

/**
 * One raw resolution attempt against the live GitHub API for `repoBase@tag`. Returns the sentinel
 * string `'NOT_FOUND'` on an HTTP 404 (a missing tag is a FINDING, never flake — never retried by
 * the caller). Returns `{type:'commit', sha}` for a lightweight tag (the majority shape — 5 of 7
 * pinned repos today) or `{type:'tag', sha, peeled}` for an annotated tag, PEELED via a second API
 * call (`git/tags/<sha>`) to the commit it actually points at — annotated-tag objects are never
 * themselves a valid pin target. THROWS on any other non-2xx status or network error — the
 * caller's retry wrapper is what turns a persistent throw into API_FAILURE.
 */
async function liveRawResolver(repoBase, tag, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token !== undefined && token !== '') headers['Authorization'] = `Bearer ${token}`;

  const refUrl = `https://api.github.com/repos/${repoBase}/git/ref/tags/${encodeURIComponent(tag)}`;
  const refRes = await fetch(refUrl, { headers });
  if (refRes.status === 404) return 'NOT_FOUND';
  if (!refRes.ok) {
    throw new Error(`GitHub API ${refRes.status} ${refRes.statusText} for ${refUrl}`);
  }
  const refBody = await refRes.json();
  const obj = refBody.object;

  if (obj.type === 'tag') {
    const tagUrl = `https://api.github.com/repos/${repoBase}/git/tags/${obj.sha}`;
    const tagRes = await fetch(tagUrl, { headers });
    if (!tagRes.ok) {
      throw new Error(`GitHub API ${tagRes.status} ${tagRes.statusText} for ${tagUrl}`);
    }
    const tagBody = await tagRes.json();
    return { type: 'tag', sha: obj.sha, peeled: tagBody.object.sha };
  }
  return { type: 'commit', sha: obj.sha };
}

/**
 * Loads a `{ "owner/repo@tag": <value> }` fixture map and returns a raw resolver reading from it
 * instead of the network — the offline CLI surface (`--resolver-fixture <json>`). `<value>` is
 * either `{type:"tag"|"commit", sha, peeled?}` (a resolution result, same shape `liveRawResolver`
 * produces) or one of two sentinels: `"NOT_FOUND"` (⇒ the `'NOT_FOUND'` string, exactly mirroring
 * a live 404 — no retry) or `"THROW"` (⇒ the resolver throws — exercises the SAME retry path a
 * live network error would).
 */
function loadFixtureResolver(fixturePath) {
  const raw = readFileSync(fixturePath, 'utf-8');
  const fixtureMap = JSON.parse(raw);
  return async function fixtureRawResolver(repoBase, tag) {
    const key = `${repoBase}@${tag}`;
    if (!(key in fixtureMap)) {
      throw new Error(
        `resolver-fixture missing entry for '${key}' — add it to the fixture JSON (this is a ` +
          `fixture-authoring error, not a pin finding).`,
      );
    }
    const value = fixtureMap[key];
    if (value === 'NOT_FOUND') return 'NOT_FOUND';
    if (value === 'THROW') throw new Error(`fixture-forced THROW for '${key}'`);
    return value;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps ANY raw resolver (live or fixture) with the shared retry policy — issue #326 rule 6: 3
 * retries with backoff, then fail CLOSED. `'NOT_FOUND'` is a normal RETURN (never thrown, never
 * retried — see the resolvers above); only a THROW enters the retry loop. Returns either the raw
 * resolver's own result value (including the `'NOT_FOUND'` sentinel) or `{ apiFailure: true,
 * error }` once every attempt has thrown.
 */
async function resolveWithRetry(
  rawResolver,
  repoBase,
  tag,
  { retries = 3, retryDelayMs = 500 } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await rawResolver(repoBase, tag);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }
  return { apiFailure: true, error: lastErr };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** One finding: a class label (one of the 6 distinct classes) + a human-readable message + the
 *  file:line it applies to (undefined `lineNumber` for a whole-group NON_UNIFORM summary line). */
function finding(cls, file, lineNumber, message) {
  return { cls, file, lineNumber, message };
}

/**
 * Classifies every `uses:` entry across every workflow file. Returns `{ findings, checkedCount,
 * distinctRepoCount, localSkipped }` — `findings` is the full, ordered list of guard failures
 * (empty ⇒ the tree passes); `checkedCount`/`distinctRepoCount` feed the passing summary line.
 * issue #326 correction: `checkedCount` stays scoped to `shaPinned` (the precise-commented
 * subset actually resolved against the API — the count of pins genuinely VERIFIED, not merely
 * syntax-valid); `distinctRepoCount` is now `byRepoBase.size`, sourced from the WIDER `shaValid`
 * NON_UNIFORM grouping. The two are only ever read together in the all-green summary line, and
 * `findings.length === 0` is only reachable when `shaValid` and `shaPinned` are the exact same
 * set (any entry in `shaValid` but not `shaPinned` would itself be a MISSING_COMMENT/
 * IMPRECISE_COMMENT finding) — so the two counts never disagree in the sentence that prints them.
 */
async function checkActionPins(dir, rawResolver, retryDelayMs) {
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));

  const allEntries = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    allEntries.push(...extractUsesEntries(content, file));
  }

  const findings = [];
  const localSkipped = [];
  /** issue #326 correction: every entry whose ref is a syntactically valid 40-hex SHA —
   *  REGARDLESS of comment state. This is the NON_UNIFORM grouping population: two pins of the
   *  same action repo at different SHAs are non-uniform whether or not either line carries a
   *  (precise) comment — a missing/imprecise comment must never mask a uniformity violation. */
  const shaValid = [];
  /** Subset of `shaValid` that ALSO carries a precise `# vX.Y.Z…` comment — the only entries
   *  eligible for API resolution (MISMATCH/TAG_NOT_FOUND/API_FAILURE need a trustworthy tag to
   *  resolve against; a missing or imprecise comment has nothing to resolve). */
  const shaPinned = [];

  for (const entry of allEntries) {
    const { repoWithPath, repoBase, ref } = splitRefExpr(entry.refExpr);

    if (repoWithPath.startsWith('./')) {
      // Local composite action — issue #326 rule 1's own carve-out: skipped-with-listing, never a
      // finding. Nothing to pin-verify (no remote tag/SHA exists for a path inside this repo).
      localSkipped.push(`${entry.file}:${entry.lineNumber} (${repoWithPath})`);
      continue;
    }
    if (repoWithPath.startsWith('docker://')) {
      // issue #326 rule 1's own carve-out: docker:// uses are not verifiable by this guard's
      // tag/SHA machinery at all — treated as an automatic, clearly-labeled failure rather than
      // silently skipped (silence here would be the exact "unverifiable read as verified" trap
      // the suspicious-result rule warns against). None exist in this repo today.
      findings.push(
        finding(
          'UNPINNED',
          entry.file,
          entry.lineNumber,
          `docker:// uses are not supported by this guard and are treated as unpinned: '${entry.raw.trim()}'.`,
        ),
      );
      continue;
    }
    if (ref === undefined || !SHA_PATTERN.test(ref)) {
      findings.push(
        finding(
          'UNPINNED',
          entry.file,
          entry.lineNumber,
          `'${repoWithPath}' is pinned to '${ref ?? '(no ref)'}, not a full 40-hex commit SHA — a ` +
            `moving ref (a branch or a tag like '@v7') can silently point at different code over ` +
            `time.`,
        ),
      );
      continue;
    }

    // issue #326 correction: join the NON_UNIFORM population NOW, before the comment checks below
    // can `continue` past it — a same-action different-SHA pin is non-uniform independent of
    // whether its comment is present/precise.
    shaValid.push({ ...entry, repoBase, ref });

    if (entry.comment === undefined || entry.comment.length === 0) {
      findings.push(
        finding(
          'MISSING_COMMENT',
          entry.file,
          entry.lineNumber,
          `'${repoBase}@${ref}' has no trailing '# vX.Y.Z' comment naming the tag this SHA is ` +
            `supposed to be — nothing to verify the pin against.`,
        ),
      );
      continue;
    }
    const firstToken = entry.comment.split(/\s+/)[0];
    if (!PRECISE_VERSION_PATTERN.test(firstToken)) {
      findings.push(
        finding(
          'IMPRECISE_COMMENT',
          entry.file,
          entry.lineNumber,
          `'${repoBase}@${ref}' comment '${firstToken}' is not an exact three-part version tag ` +
            `(expected /^v\\d+\\.\\d+\\.\\d+/) — a major-only tag like 'v7' names a MOVING tag that ` +
            `can silently drift true→false without this line ever changing.`,
        ),
      );
      continue;
    }

    shaPinned.push({ ...entry, repoBase, ref, tag: firstToken });
  }

  // Resolve every DISTINCT (repoBase, tag) pair exactly once — codeql-action's 3 subpaths (init/
  // analyze/upload-sarif) all cite the same tag, and re-resolving per LINE instead of per PAIR
  // would triple its API cost for zero additional information (the ~9-calls-per-run budget vs
  // the 60/hr anonymous limit assumes this dedup). Every entry sharing a pair reuses the one
  // resolution.
  const resolutionCache = new Map();
  for (const entry of shaPinned) {
    const key = `${entry.repoBase}@${entry.tag}`;
    if (!resolutionCache.has(key)) {
      resolutionCache.set(
        key,
        await resolveWithRetry(rawResolver, entry.repoBase, entry.tag, { retryDelayMs }),
      );
    }
  }

  for (const entry of shaPinned) {
    const result = resolutionCache.get(`${entry.repoBase}@${entry.tag}`);
    if (result === 'NOT_FOUND') {
      findings.push(
        finding(
          'TAG_NOT_FOUND',
          entry.file,
          entry.lineNumber,
          `'${entry.repoBase}' has no tag '${entry.tag}' — the comment names a tag that does not ` +
            `exist on the action's repo.`,
        ),
      );
      continue;
    }
    if (result && result.apiFailure === true) {
      findings.push(
        finding(
          'API_FAILURE',
          entry.file,
          entry.lineNumber,
          `could not resolve '${entry.repoBase}@${entry.tag}' after 3 retries — this is an ` +
            `INFRASTRUCTURE failure (network/API), NOT a pin finding: ${result.error?.message ?? result.error}. ` +
            `An unverifiable pin must never be reported as a verified one — re-run once the API is ` +
            `reachable.`,
        ),
      );
      continue;
    }
    const resolvedCommit = result.type === 'tag' ? result.peeled : result.sha;
    if (resolvedCommit !== entry.ref) {
      findings.push(
        finding(
          'MISMATCH',
          entry.file,
          entry.lineNumber,
          `'${entry.repoBase}' tag '${entry.tag}' resolves to commit '${resolvedCommit}', but the ` +
            `pin is '${entry.ref}'. TWO live hypotheses — investigate provenance, never "fix" by ` +
            `editing the comment to match: (1) the comment LIES (the SHA was changed without ` +
            `updating the comment, e.g. a bad merge/rebase or a manual edit); (2) upstream ` +
            `RE-POINTED the tag (a mutable tag was force-moved after this pin was written — this ` +
            `guard's weekly scheduled run exists specifically to catch this between PRs).`,
        ),
      );
    }
  }

  // NON_UNIFORM: group every SHA-VALID entry — issue #326 correction: `shaValid`, not `shaPinned`
  // — REGARDLESS of comment precision or resolution outcome (this is a purely structural
  // same-repo-different-SHA check, and the block comment's claim is now literally true: a line
  // with no comment at all, or an imprecise one, still joins this grouping). Any group with more
  // than one distinct SHA gets every one of its entries flagged.
  const byRepoBase = new Map();
  for (const entry of shaValid) {
    const list = byRepoBase.get(entry.repoBase) ?? [];
    list.push(entry);
    byRepoBase.set(entry.repoBase, list);
  }
  for (const [repoBase, entries] of byRepoBase) {
    const distinctShas = new Set(entries.map((e) => e.ref));
    if (distinctShas.size > 1) {
      const locations = entries.map((e) => `${e.file}:${e.lineNumber} (${e.ref})`).join(', ');
      for (const entry of entries) {
        findings.push(
          finding(
            'NON_UNIFORM',
            entry.file,
            entry.lineNumber,
            `'${repoBase}' is pinned to ${distinctShas.size} DIFFERENT SHAs across the workflow ` +
              `files — every use of the same action must share one pin: ${locations}.`,
          ),
        );
      }
    }
  }

  return {
    findings,
    checkedCount: shaPinned.length,
    distinctRepoCount: byRepoBase.size,
    localSkipped,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isFixtureMode = args.resolverFixture !== undefined;
  // Fixture-implies-zero: probe transcripts must never sleep through a real backoff. --retry-delay-ms
  // is a LIVE-MODE-ONLY knob; fixture mode always overrides it to 0 regardless of the flag.
  const retryDelayMs = isFixtureMode ? 0 : args.retryDelayMs;

  const rawResolver = isFixtureMode
    ? loadFixtureResolver(args.resolverFixture)
    : (repoBase, tag) => liveRawResolver(repoBase, tag, process.env.GITHUB_TOKEN);

  const { findings, checkedCount, distinctRepoCount, localSkipped } = await checkActionPins(
    args.dir,
    rawResolver,
    retryDelayMs,
  );

  if (localSkipped.length > 0) {
    console.log(
      `ℹ ${localSkipped.length} local composite action(s) skipped (not remote-verifiable):`,
    );
    for (const s of localSkipped) console.log(`  • ${s}`);
  }

  if (findings.length === 0) {
    console.log(
      `✓ action pin truth guard: ${checkedCount} SHA-pinned use(s) across ${distinctRepoCount} ` +
        `distinct action repo(s), all truthful, precise, and uniform.`,
    );
    return;
  }

  for (const f of findings) {
    console.error(`✗ [${f.cls}] ${f.file}:${f.lineNumber}: ${f.message}`);
  }
  console.error(
    `\naction pin truth guard FAILED — ${findings.length} finding(s) across ${checkedCount} ` +
      `checked pin(s). See errors above.`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`✗ action pin truth guard crashed: ${err.stack ?? err}`);
  process.exitCode = 1;
});

export {
  parseArgs,
  extractUsesEntries,
  splitRefExpr,
  liveRawResolver,
  loadFixtureResolver,
  resolveWithRetry,
  checkActionPins,
};
