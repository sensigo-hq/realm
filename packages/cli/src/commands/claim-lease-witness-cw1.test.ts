// claim-lease-witness-cw1.test.ts — issue #729, the claim window, unit CW-1: the source-text witness of
// the claim lease's three rules, read with the TypeScript parser (a comment is never code):
//   1. the lease module (`store-sqlite/src/claim-lease.ts`) takes from `node:fs` only what it needs to
//      make, close, delete, stat and check a lease file and its folder, plus `constants`, and nothing
//      from `node:fs/promises`: in the holding program, a plain open and close of a lease file lets go
//      of the lock (CW-PR-02), so no other file function may creep into the one module that opens them;
//   2. no production source outside that module names the folder `claim-leases` in a literal: the
//      module is the one place that makes or opens it;
//   3. only the files of a closed list call a lease port's `hold(` (#729 CW-2a): core's
//      `claimStepForDrive` (the one engine entry that takes a lease) and realm-testing's leased-claim
//      laws (which take their holds from the store's port, as a drive does). The list is checked both
//      ways: a call in another file is refused, and so is a listed file that no longer calls it (the
//      list would then be wider than the code). No Realm command takes a lease yet (the CHANGELOG and
//      the core library's reference say so; CW-5 is the unit that will).
//   4. only the files of a closed list call core's `claimStepForDrive(` or `releaseDriveClaim(` (#729
//      CW-2a, correction 1), checked both ways as rule 3 is. The list is empty: the sentences "No Realm
//      command calls them yet" (the CHANGELOG) and "No Realm command takes a lease yet" (the CHANGELOG
//      and the core library's reference) hold while no production file calls either. Their
//      definitions in `drive-claim.ts` are not calls; the cell also checks that it read them, so a
//      walk that misses the file cannot pass for an empty one.
//   5. only the files of a closed list pass `executeChain` a `heldClaim` (#729 CW-2b), checked both
//      ways: an `executeChain(` call whose arguments hold a property named `heldClaim`, or any object
//      literal with that property (options built beside the call). The list is empty: "No Realm
//      command passes it yet" (the CHANGELOG) holds while no production file does. The cell also
//      checks it read the option's declaration in `ExecuteChainOptions`. It cannot see an options
//      object built with a computed key, or passed through a spread of one built elsewhere.
//
// WHAT IT SEES: every `.ts` file under `packages/*/src` but tests (`*.test.ts`), declarations and the
// `test-support` folders. WHAT IT CANNOT SEE: a call through a computed name (`port[name]()`), a call
// in a test, a file function reached through another module the lease module imports.
//
// HOME: the cli package, as the source censuses (`clock-census-715b.test.ts`): cli's test task waits
// for every package's build, so an edit in any package's source re-hashes it.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEASE_MODULE = 'store-sqlite/src/claim-lease.ts';

/** #729 CW-2a (correction 1): the production files that may call `claimStepForDrive(` or
 *  `releaseDriveClaim(`, each with its reason. Empty: no Realm command calls them yet (CW-5's
 *  `realm agent` will be the first entry here). */
const DRIVE_ENTRY_CALLERS: Readonly<Record<string, string>> = {};

/** #729 CW-2b: the production files that may pass `executeChain` a `heldClaim`, each with its reason.
 *  Empty: no Realm command passes it yet (CW-5's `realm agent` will be the first entry here). */
const HELD_CLAIM_PASSERS: Readonly<Record<string, string>> = {};

/** #729 CW-2a: the two engine entries a drive takes and gives back its claim through. */
const DRIVE_ENTRIES = ['claimStepForDrive', 'releaseDriveClaim'];

/** #729 CW-2a: the production files that may call a lease port's `hold(`, each with its reason. */
const HOLD_CALLERS: Readonly<Record<string, string>> = {
  'core/src/engine/drive-claim.ts': 'claimStepForDrive takes the lease a drive claims a step under',
  'testing/src/store/leased-claim-contract.ts':
    "the leased-claim laws take their holds from the store's own port",
};

/** What the lease module may take from `node:fs`: make, close, delete, mkdir, stat, access, constants. */
const ALLOWED_FS = [
  'accessSync',
  'closeSync',
  'constants',
  'mkdirSync',
  'openSync',
  'statSync',
  'unlinkSync',
];

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'test-support') walk(path);
      } else if (name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(name)) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const src = join(PACKAGES, pkg, 'src');
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory() === true) walk(src);
  }
  return out;
}

const rel = (path: string): string => relative(PACKAGES, path).split(sep).join('/');

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every string and template literal's text in a file, with its line. */
function literals(sf: ts.SourceFile): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: lineOf(sf, node), text: node.text });
    } else if (ts.isTemplateExpression(node)) {
      out.push({
        line: lineOf(sf, node),
        text: node.head.text + node.templateSpans.map((s) => s.literal.text).join(''),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every call of a member named `hold` in a file (`x.hold(…)`, `x?.hold(…)`, `x['hold'](…)`). */
function holdCalls(sf: ts.SourceFile): number[] {
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'hold') ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === 'hold');
      if (named) out.push(lineOf(sf, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every call of one of `names` in a file (`f(…)`, `x.f(…)`, `x?.f(…)`, `x['f'](…)`), by name and line. */
function callsOf(sf: ts.SourceFile, names: readonly string[]): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : undefined;
      if (name !== undefined && names.includes(name)) out.push({ name, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** #729 CW-2b: the property names `heldClaim` written in object literals (`{ heldClaim: … }`,
 *  `{ heldClaim }`), each with its line — inside an `executeChain(` call or beside one. */
function heldClaimProperties(sf: ts.SourceFile): number[] {
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'heldClaim'
    ) {
      out.push(lineOf(sf, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** #729 CW-2b: whether a file declares the `heldClaim` member of an interface named `ExecuteChainOptions`. */
function declaresHeldClaim(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (st) =>
      ts.isInterfaceDeclaration(st) &&
      st.name.text === 'ExecuteChainOptions' &&
      st.members.some(
        (m) => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === 'heldClaim',
      ),
  );
}

/** The names of the functions a file declares at its top level (`export async function f(`). */
function declaredFunctions(sf: ts.SourceFile): string[] {
  return sf.statements.flatMap((s) =>
    ts.isFunctionDeclaration(s) && s.name !== undefined ? [s.name.text] : [],
  );
}

describe('#729 CW-1 — the claim lease’s source witness', () => {
  const files = productionFiles();

  it('the lease module takes from node:fs only what it needs, and nothing from node:fs/promises', () => {
    const sf = parse(join(PACKAGES, LEASE_MODULE));
    const fromFs: string[] = [];
    const refused: string[] = [];
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const from = statement.moduleSpecifier.text;
      if (!['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(from)) continue;
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (from.endsWith('promises')) refused.push(`an import from ${from}`);
      if (clause?.name !== undefined) refused.push(`the default import of ${from}`);
      if (bindings !== undefined && ts.isNamespaceImport(bindings))
        refused.push(`the namespace import of ${from}`);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          fromFs.push((element.propertyName ?? element.name).text);
      }
    }
    // (1) red when the module takes another file function (a `readFileSync` added), imports the whole
    //     module or its promises, or no longer imports from node:fs at all (the scan then sees
    //     nothing); (2) prints the names it takes and what was refused.
    expect({
      outside: fromFs.filter((n) => !ALLOWED_FS.includes(n)),
      refused,
      seen: fromFs.length > 0,
    }).toEqual({ outside: [], refused: [], seen: true });
  });

  it('no production source outside the lease module names claim-leases in a literal', () => {
    const named = files.flatMap((path) =>
      literals(parse(path))
        .filter((l) => l.text.includes('claim-leases'))
        .map((l) => `${rel(path)}:${l.line}`),
    );
    // (1) red when another file builds the folder's path from its own literal (it would open what
    //     only the lease module may), or the module's own constant is gone (the scan then sees no
    //     literal: its reader is blind); (2) prints each file and line.
    expect({
      files: files.length > 0,
      inTheModule: named.filter((n) => n.startsWith(`${LEASE_MODULE}:`)).length,
      elsewhere: named.filter((n) => !n.startsWith(`${LEASE_MODULE}:`)),
    }).toEqual({ files: true, inTheModule: 1, elsewhere: [] });
  });

  it('only the listed files call a lease port’s hold(), and each listed file does', () => {
    const calls = files.flatMap((path) =>
      holdCalls(parse(path)).map((line) => ({ file: rel(path), line })),
    );
    const listed = Object.keys(HOLD_CALLERS).sort();
    // (1) red when another production file calls `hold(` (a command taking a lease makes the
    //     sentences "no Realm command takes a lease yet" in the CHANGELOG and the core library's
    //     reference false), or a listed file no longer calls it (the list is then wider than the
    //     code); (2) prints each call outside the list with its file and line, and the files that do
    //     call it.
    expect({
      outside: calls.filter((c) => !listed.includes(c.file)).map((c) => `${c.file}:${c.line}`),
      calling: [...new Set(calls.map((c) => c.file))].sort(),
    }).toEqual({ outside: [], calling: listed });
  });

  it('only the listed files call claimStepForDrive() or releaseDriveClaim() — none today — and the walk read their definitions', () => {
    const calls = files.flatMap((path) =>
      callsOf(parse(path), DRIVE_ENTRIES).map((c) => ({ file: rel(path), ...c })),
    );
    const listed = Object.keys(DRIVE_ENTRY_CALLERS).sort();
    const definedIn = files
      .filter((path) => rel(path) === 'core/src/engine/drive-claim.ts')
      .flatMap((path) => declaredFunctions(parse(path)).filter((n) => DRIVE_ENTRIES.includes(n)));
    // (1) red when a production file outside the list calls either entry (a command calling one
    //     makes "No Realm command calls them yet" and "No Realm command takes a lease yet" false), a
    //     listed file no longer calls one, or the walk no longer reads the two definitions (it would
    //     then see nothing); (2) prints each call outside the list with its file, line and name, the
    //     files that call one, and the definitions it read.
    expect({
      outside: calls
        .filter((c) => !listed.includes(c.file))
        .map((c) => `${c.file}:${c.line} ${c.name}`),
      calling: [...new Set(calls.map((c) => c.file))].sort(),
      definedIn: definedIn.sort(),
    }).toEqual({ outside: [], calling: listed, definedIn: [...DRIVE_ENTRIES].sort() });
  });

  it('only the listed files pass executeChain a heldClaim — none today — and the walk read the option', () => {
    const passes = files.flatMap((path) =>
      heldClaimProperties(parse(path)).map((line) => ({ file: rel(path), line })),
    );
    const listed = Object.keys(HELD_CLAIM_PASSERS).sort();
    const declaredIn = files.filter((path) => declaresHeldClaim(parse(path))).map(rel);
    // (1) red when a production file outside the list writes a `heldClaim` property (a command
    //     passing it makes "No Realm command passes it yet" false), a listed file no longer does, or
    //     the walk no longer reads the option's declaration (it would then see nothing); (2) prints
    //     each one outside the list with its file and line, the files that pass it, and where the
    //     option is declared.
    expect({
      outside: passes.filter((p) => !listed.includes(p.file)).map((p) => `${p.file}:${p.line}`),
      passing: [...new Set(passes.map((p) => p.file))].sort(),
      declaredIn,
    }).toEqual({ outside: [], passing: listed, declaredIn: ['core/src/engine/execution-loop.ts'] });
  });
});
