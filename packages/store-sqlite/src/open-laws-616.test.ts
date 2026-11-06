// open-laws-616.test.ts — issue #616 PR-1a unit 7a: two source laws of the open, as scans of the
// package's production code (every `.ts` file under `src/` but tests and `src/test-support/**`),
// read with the TypeScript compiler so that names resolve as the compiler resolves them.
//
// L-FS (design §2 step 4): Realm's code touches a `realm.db*` path with the filesystem only by `lstat`
// and by the ONE exclusive create of an absent `realm.db`. Nothing renames, links, copies, writes,
// opens or deletes it by `fs`; SQLite alone reads and writes it, through the loader. The scan follows
// the path: it starts at the name's one constant (`DATABASE_FILE`) and at every result of
// `prepareHome`, and follows it into every variable set from it and every parameter of a function of
// the package it is passed to; every `node:fs` call one of those reaches must be an `lstat` or that
// create, and the create's own descriptor may only be closed. It also finds every string that spells a `realm.db*` file name or path, which must be the
// constant alone. What it cannot see (said, not hidden): a path built at run time from parts that are
// not the constant (`'realm' + '.db'`), a path stored in an object's property and read back, a call
// through a function value it cannot resolve.
//
// One opener: no module of the package opens a connection on a file through the loader
// (`openDatabase` with anything but `':memory:'`) except the open, unit 7b's, which adds itself to
// `OPENERS` below. Until then the list is empty; the schema ladder's in-memory reference database is
// allowed anywhere.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PACKAGE_ROOT, 'src');
const LOADER = 'src/driver.ts';
/** The modules that may open a connection on a file through the loader, each with its reason. */
const OPENERS: Record<string, string> = {};

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test-support') productionFiles(path, out);
    } else if (/\.ts$/.test(name) && !/\.(?:test|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** The package's production files in one program, with the package's own compiler options. */
function packageProgram(): { program: ts.Program; files: ts.SourceFile[] } {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(PACKAGE_ROOT, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  const names = productionFiles(SRC);
  const program = ts.createProgram(names, { ...(config?.options ?? {}), noEmit: true });
  const files = names.map((n) => program.getSourceFile(n)!).filter((f) => f !== undefined);
  return { program, files };
}

const rel = (file: ts.SourceFile): string =>
  relative(PACKAGE_ROOT, file.fileName).split(sep).join('/');
const where = (node: ts.Node): string => {
  const file = node.getSourceFile();
  return `${rel(file)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** A string's text that is a `realm.db*` file name, or a path that ends in one. */
const DATABASE_NAME = /^realm\.db(?:-wal|-shm)?$|[\\/]realm\.db(?:-wal|-shm)?(?:$|['"`])/;

describe('#616 unit 7a — the source laws of the open', () => {
  const { program, files } = packageProgram();
  const checker = program.getTypeChecker();

  /** A symbol, followed through an import to what it names. */
  const resolved = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return undefined;
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };

  /** The `node:fs` function a call calls, by its name; undefined for any other callee. */
  const fsFunction = (call: ts.CallExpression): string | undefined => {
    const callee = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name
      : call.expression;
    const declaration = resolved(callee)?.declarations?.[0];
    const from = declaration?.getSourceFile().fileName.split(sep).join('/') ?? '';
    if (!/\/@types\/node\/fs(?:\/promises)?\.d\.ts$/.test(from)) return undefined;
    return ts.isIdentifier(callee) ? callee.text : undefined;
  };

  it('L-FS: a realm.db path reaches no filesystem call but an lstat and the one exclusive create, and only the constant spells the name', () => {
    const tracked = new Set<ts.Symbol>();
    /** The descriptors the one create returns: only closing them is allowed. */
    const descriptors = new Set<ts.Symbol>();
    const isTheCreate = (n: ts.Node): n is ts.CallExpression => {
      if (!ts.isCallExpression(n) || fsFunction(n) !== 'openSync') return false;
      const [path, flag, mode] = n.arguments;
      return (
        path !== undefined &&
        holds(path) &&
        flag !== undefined &&
        ts.isStringLiteral(flag) &&
        flag.text === 'wx' &&
        mode?.getText() === '0o600'
      );
    };
    const isSeed = (n: ts.Node): boolean =>
      (ts.isIdentifier(n) && n.text === 'DATABASE_FILE') ||
      (ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'prepareHome');
    /** Whether an expression names something in `set`, or (for paths) holds a seed. */
    const names = (expr: ts.Node, set: Set<ts.Symbol>, seeds: boolean): boolean => {
      let found = false;
      walk(expr, (n) => {
        if (found) return;
        if (seeds && isSeed(n)) found = true;
        else if (ts.isIdentifier(n)) {
          const s = resolved(n);
          if (s !== undefined && set.has(s)) found = true;
        }
      });
      return found;
    };
    /** Whether an expression holds a realm.db path: a seed, or a name the scan follows. */
    function holds(expr: ts.Node): boolean {
      return names(expr, tracked, true);
    }
    const follow = (name: ts.Node, into: Set<ts.Symbol> = tracked): boolean => {
      const s = resolved(name);
      if (s === undefined || into.has(s)) return false;
      into.add(s);
      return true;
    };
    // To a fixed point: variables set from a held path, and parameters a held path is passed to.
    for (let grew = true; grew;) {
      grew = false;
      for (const file of files) {
        walk(file, (n) => {
          const set =
            ts.isVariableDeclaration(n) && n.initializer !== undefined
              ? { to: n.name, from: n.initializer }
              : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ? { to: n.left, from: n.right }
                : undefined;
          if (set !== undefined && isTheCreate(set.from)) {
            grew = follow(set.to, descriptors) || grew;
          } else if (set !== undefined && holds(set.from)) {
            grew = follow(set.to) || grew;
          } else if (ts.isCallExpression(n)) {
            const declaration = resolved(n.expression)?.valueDeclaration;
            const fn =
              declaration !== undefined &&
              (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
                ? declaration
                : declaration !== undefined &&
                    ts.isVariableDeclaration(declaration) &&
                    declaration.initializer !== undefined &&
                    (ts.isArrowFunction(declaration.initializer) ||
                      ts.isFunctionExpression(declaration.initializer))
                  ? declaration.initializer
                  : undefined;
            if (fn === undefined || !files.includes(fn.getSourceFile())) return;
            n.arguments.forEach((arg, i) => {
              const parameter = fn.parameters[i];
              if (parameter !== undefined && holds(arg)) grew = follow(parameter.name) || grew;
            });
          }
        });
      }
    }
    const findings: string[] = [];
    const creates: string[] = [];
    const spellings: string[] = [];
    for (const file of files) {
      walk(file, (n) => {
        if (ts.isCallExpression(n)) {
          const name = fsFunction(n);
          if (name === undefined) return;
          const onPath = n.arguments.some(holds);
          const onDescriptor = n.arguments.some((a) => names(a, descriptors, false));
          if (!onPath && !onDescriptor) return;
          const text = `${name}(${n.arguments.map((a) => a.getText()).join(', ')})`;
          if (isTheCreate(n)) creates.push(`${rel(file)}: ${text}`);
          else if (onPath && (name === 'lstat' || name === 'lstatSync')) return;
          else if (!onPath && name === 'closeSync') return;
          else findings.push(`${where(n)}: ${text}`);
        } else if (
          (ts.isStringLiteral(n) ||
            ts.isNoSubstitutionTemplateLiteral(n) ||
            ts.isTemplateLiteralToken(n)) &&
          DATABASE_NAME.test(n.text)
        ) {
          const declaration = ts.isVariableDeclaration(n.parent) ? n.parent.getText() : n.getText();
          spellings.push(`${rel(file)}: ${declaration}`);
        }
      });
    }
    // (1) red when a filesystem call other than an lstat or the one exclusive create takes a
    //     realm.db path (an unlink, a rename, a write, a second create or a create with another mode),
    //     when the create's descriptor is used for anything but its close (a write, a chmod),
    //     when a second string spells the file's name or a path to it, or when the scan stops seeing
    //     the create (it would then be reading nothing); (2) prints each finding with its file and
    //     line and the call's text, every create and every spelling it found.
    expect({ findings, creates, spellings }).toEqual({
      findings: [],
      creates: ["src/home.ts: openSync(path, 'wx', 0o600)"],
      spellings: ["src/home.ts: DATABASE_FILE = 'realm.db'"],
    });
  });

  it('one opener: no module but the open (none yet) opens a connection on a file through the loader', () => {
    const opens: string[] = [];
    let memory = 0;
    for (const file of files) {
      if (rel(file) === LOADER) continue;
      walk(file, (n) => {
        if (!ts.isCallExpression(n)) return;
        const declaration = resolved(n.expression)?.declarations?.[0];
        if (declaration === undefined || rel(declaration.getSourceFile()) !== LOADER) return;
        if (!ts.isFunctionDeclaration(declaration) || declaration.name?.text !== 'openDatabase')
          return;
        const [first] = n.arguments;
        if (first !== undefined && ts.isStringLiteral(first) && first.text === ':memory:')
          memory += 1;
        else if (!(rel(file) in OPENERS)) opens.push(`${where(n)}: ${n.getText()}`);
      });
    }
    // (1) red when a module outside the open's list opens a database on a path through the loader
    //     (a second opener, which would skip the open's checks), or when the scan stops seeing the
    //     schema ladder's in-memory open (it would then be resolving nothing); (2) prints each
    //     opener with its file and line, and the count of in-memory opens.
    expect({ opens, memorySeen: memory > 0 }).toEqual({ opens: [], memorySeen: true });
  });
});
