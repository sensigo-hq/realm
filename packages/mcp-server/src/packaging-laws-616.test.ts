// packaging-laws-616.test.ts — issue #616 PR-2c c10b-3b: packaging law (C) of design-d4. A host that
// injects its own stores imports the library, and the library must not reach the store package: on a
// Node with no SQLite, that reach would stop the host at load. The cell reads the BUILT `dist/`, which
// the test task builds first, and walks the imports with TypeScript's parser, so a comment or a string
// that looks like an import is not one.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const STORE_PACKAGE = '@sensigo/realm-store-sqlite';

/** The string a `const` of this module holds, when one by this name has a string-literal initializer. */
function constLiteral(source: ts.SourceFile, name: string): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer !== undefined &&
          ts.isStringLiteralLike(declaration.initializer)
        ) {
          found = declaration.initializer.text;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every module specifier one built file names, and each `import()` it cannot be judged by. */
function edgesOf(file: string): { specifiers: string[]; refused: string[] } {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];
  const refused: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const literal =
        argument !== undefined && ts.isStringLiteralLike(argument)
          ? argument.text
          : argument !== undefined && ts.isIdentifier(argument)
            ? constLiteral(source, argument.text)
            : undefined;
      if (literal !== undefined) specifiers.push(literal);
      else refused.push(`${relative(DIST, file)}: import(${argument?.getText(source) ?? ''})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, refused };
}

/** Follows every relative specifier from one built entry; `files` are paths under `dist/`. */
function walk(entry: string): { files: Set<string>; bare: Set<string>; refused: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const refused: string[] = [];
  const queue = [join(DIST, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const name = relative(DIST, file);
    if (files.has(name)) continue;
    files.add(name);
    if (!existsSync(file)) {
      refused.push(`${name}: no such module under dist/`);
      continue;
    }
    const edges = edgesOf(file);
    refused.push(...edges.refused);
    for (const specifier of edges.specifiers) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
      else bare.add(specifier);
    }
  }
  return { files, bare, refused };
}

const isStorePackage = (specifier: string): boolean =>
  specifier === STORE_PACKAGE || specifier.startsWith(`${STORE_PACKAGE}/`);

describe('#616 PR-2c c10b-3b — packaging law (C)', () => {
  it('the library a host imports reaches no store package, and every import() in it can be judged', () => {
    const library = walk('index.js');
    const home = walk('home-server.js');
    // (a) red when the library's closure gains the store package, or an import() whose argument is
    //     neither a string nor a const holding one; or when the walk stops seeing: `dist/index.js` is
    //     re-exports only, so a walker without `export … from` edges never reaches server.js, and one
    //     without import() edges never reaches the price list's const-held specifier;
    // (b) prints whether it saw each, what it reached and what it refused.
    expect({
      reachesServer: library.files.has('server.js'),
      judgedTheConstHeldImport: library.bare.has('@pydantic/genai-prices'),
      storeReferences: [...library.bare].filter(isStorePackage),
      refused: library.refused,
    }).toEqual({
      reachesServer: true,
      judgedTheConstHeldImport: true,
      storeReferences: [],
      refused: [],
    });
    // (a) red when the walk would not see a store reference at all: the home entry is the one module
    //     that must have one; (b) prints the entry's external specifiers.
    expect([...home.bare].filter(isStorePackage), [...home.bare].join(', ')).toEqual([
      STORE_PACKAGE,
    ]);
  });
});
