// release-command-names-616.test.ts — #616 PR-2c c13b, law (B), the command-name law: every command a
// person is told to type is a command realm has, read from the CLI's own registry.
//
// WHAT IT READS, two source classes:
// (i) docs a person reads: `README.md`, `packages/*/README.md`, `docs/**/*.md`, `SECURITY.md`,
//     `.github/instructions/*.md`, and `CHANGELOG.md`'s `## [Unreleased]` section except its
//     `### Removed` subsection (a removed command is named there to say it is gone; released entries are
//     history and name commands removed since). A phrase is a backticked span beginning `realm ` outside
//     a fenced block (read as Markdown does: a run of N backticks closes at the next run of N, and a span
//     may wrap onto the next line of its paragraph — `CHANGELOG.md` has one), or a fenced block's line
//     beginning `realm `. A former command named in another subsection is red, and is written as prose
//     ("the former `gc` command"), never as a command.
// (ii) the product's own messages: the string and template literals of every non-test `.ts` under
//     `packages/*/src` (not `*.test.ts`, not a `test-support` folder), found by the TypeScript parser,
//     which drives its scanner with the parse context, so a regex literal is never read as a string and a
//     comment is never a message. A phrase is a span between backticks INSIDE the literal's text (`\``
//     in a template, a bare backtick in a quoted string) beginning `realm `; a template's own delimiters
//     never bound a phrase, and a substitution reads as `${…}`.
// A span that opens on `realm` and never closes is red: the law cannot judge it. A phrase's PATH is
// `realm` and the run of words `[a-z][a-z-]*` after it, up to the first word that is not one (a flag, a
// placeholder, a path, a word with a digit or a dot, punctuation).
//
// THE REGISTRY: `commands-registry.ts`'s four exports, read as Commander objects (`.name()`), never a
// hand-written list; the groups are `workflow`, `run` and `db`, as the CLI's `index.ts` names the
// commands that hold `workflowCommands`, `runCommands` and `dbCommands`. Valid: `realm` alone; `realm
// <top>` (words after it are arguments); `realm <group>` alone; `realm <group> <sub>` (words after it are
// arguments). Anything else is red.
//
// WHAT IT CANNOT SEE: a command a template builds from its own delimiters — `CLI_COMMANDS.*` in
// `ways-renderer.ts` (pinned by `ways-renderer.test.ts`), and the commands passed to `ctx.cmd(…)` as a
// template of their own (`ctx.cmd(`realm run inspect ${runId}`)`, inside a message or not); a command
// split across two literals; in the docs, a command quoted inside another code span (a double-backtick
// span quoting a message) or in the middle of a fenced line (`REALM_SERVE_TOKEN=… realm serve`); a
// command in a comment, an HTML tag, an indented code block or a released changelog entry; whether a
// command's arguments and flags exist (`agent/reattach-commands-676.test.ts` pins printed flags).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  dbCommands,
  runCommands,
  topLevelCommands,
  workflowCommands,
} from './commands-registry.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const TOP = new Set(topLevelCommands.map((c) => c.name()));
const GROUPS = new Map<string, Set<string>>([
  ['workflow', new Set(workflowCommands.map((c) => c.name()))],
  ['run', new Set(runCommands.map((c) => c.name()))],
  ['db', new Set(dbCommands.map((c) => c.name()))],
]);

interface Phrase {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Why a phrase names no command realm has, or `undefined` when it names one. */
function judge(text: string): string | undefined {
  if (!text.startsWith('realm ')) return 'the law cannot judge it: a span that does not close';
  const path: string[] = [];
  for (const word of text.slice('realm '.length).split(/\s+/)) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    path.push(word);
  }
  const [first, second] = path;
  if (first === undefined || TOP.has(first)) return undefined;
  const subs = GROUPS.get(first);
  if (subs === undefined) return `"${first}" is neither a command nor a group of realm`;
  if (second === undefined || subs.has(second)) return undefined;
  return `"${second}" is not a command of realm ${first}`;
}

/**
 * The code spans of a paragraph (CommonMark: a run of N backticks closes at the next run of N; a line
 * end inside a span reads as a space). `at` is the opening run's offset in the paragraph.
 */
function spansOf(text: string): { at: number; text: string; closed: boolean }[] {
  const out: { at: number; text: string; closed: boolean }[] = [];
  const runs = [...text.matchAll(/(?<!\\)`+/g)];
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i]!;
    const from = open.index + open[0].length;
    const close = runs.findIndex((r, j) => j > i && r[0].length === open[0].length);
    if (close === -1) {
      out.push({ at: open.index, text: text.slice(from).split('\n')[0]!, closed: false });
      continue;
    }
    let span = text.slice(from, runs[close]!.index).replace(/\n/g, ' ');
    if (/^ .*[^ ].* $/.test(span)) span = span.slice(1, -1);
    out.push({ at: open.index, text: span, closed: true });
    i = close;
  }
  return out;
}

/** A line that starts a block of its own: a heading, a list item, a quote, a table row. */
const NEW_BLOCK = /^\s*(#|[-*+] |\d+[.)] |>|\|)/;

/** The phrases of Markdown lines (`[line number, text]`), read paragraph by paragraph. */
function markdownPhrases(file: string, lines: readonly (readonly [number, string])[]): Phrase[] {
  const out: Phrase[] = [];
  let fence: string | undefined;
  let paragraph: (readonly [number, string])[] = [];
  const flush = (): void => {
    const starts: [number, number][] = [];
    let offset = 0;
    for (const [line, text] of paragraph) {
      starts.push([offset, line]);
      offset += text.length + 1;
    }
    for (const s of spansOf(paragraph.map(([, text]) => text).join('\n'))) {
      if (s.text.startsWith('realm ') || (!s.closed && /^\s*realm\b/.test(s.text))) {
        const line = starts.filter(([o]) => o <= s.at).at(-1)![1];
        out.push({ file, line, text: s.closed ? s.text : `\`${s.text}` });
      }
    }
    paragraph = [];
  };
  for (const [line, text] of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence !== undefined) {
      if (new RegExp(`^\\s*\\${fence[0]}{${fence.length},}\\s*$`).test(text)) fence = undefined;
      else if (text.trimStart().startsWith('realm ')) out.push({ file, line, text: text.trim() });
    } else if (marker !== undefined) {
      flush();
      fence = marker;
    } else {
      if (text.trim() === '' || NEW_BLOCK.test(text)) flush();
      if (text.trim() !== '') paragraph.push([line, text]);
      if (/^\s*#/.test(text)) flush();
    }
  }
  flush();
  return out;
}

/** `CHANGELOG.md`'s `## [Unreleased]` section without its `### Removed` subsection, numbered. */
function unreleased(text: string): [number, string][] {
  const out: [number, string][] = [];
  let inside = false;
  let removed = false;
  text.split('\n').forEach((line, i) => {
    if (/^## /.test(line)) inside = line.startsWith('## [Unreleased]');
    if (/^#{2,3} /.test(line)) removed = line.startsWith('### Removed');
    if (inside && !removed) out.push([i + 1, line]);
  });
  return out;
}

/** The phrases of one TypeScript source's string and template literals. */
function messagePhrases(file: string, source: string): Phrase[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: Phrase[] = [];
  const read = (node: ts.Node, text: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const parts = text.split('`');
    for (let i = 1; i < parts.length; i += 2) {
      const closed = i < parts.length - 1;
      if (parts[i]!.startsWith('realm ') || (!closed && /^\s*realm\b/.test(parts[i]!))) {
        out.push({ file, line, text: closed ? parts[i]! : `\`${parts[i]!}` });
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      read(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      read(node, node.head.text + node.templateSpans.map((s) => `\${…}${s.literal.text}`).join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'test-support') out.push(...walk(path, keep));
    } else if (keep(path)) out.push(path);
  }
  return out;
}

const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');
const numbered = (text: string): [number, string][] => text.split('\n').map((l, i) => [i + 1, l]);

function docsClass(): { files: number; phrases: Phrase[] } {
  const packages = join(ROOT, 'packages');
  const files = [
    join(ROOT, 'README.md'),
    ...readdirSync(packages)
      .sort()
      .map((d) => join(packages, d, 'README.md')),
    ...walk(join(ROOT, 'docs'), (p) => p.endsWith('.md')),
    join(ROOT, 'SECURITY.md'),
    ...walk(join(ROOT, '.github', 'instructions'), (p) => p.endsWith('.md')),
  ].filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile() === true);
  const phrases = files.flatMap((f) => markdownPhrases(rel(f), numbered(readFileSync(f, 'utf8'))));
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  phrases.push(...markdownPhrases('CHANGELOG.md', unreleased(changelog)));
  return { files: files.length + 1, phrases };
}

function productClass(): { files: number; phrases: Phrase[] } {
  const packages = join(ROOT, 'packages');
  const files = readdirSync(packages)
    .sort()
    .flatMap((d) =>
      statSync(join(packages, d, 'src'), { throwIfNoEntry: false })?.isDirectory() === true
        ? walk(join(packages, d, 'src'), (p) => p.endsWith('.ts') && !/\.(test|d)\.ts$/.test(p))
        : [],
    );
  return {
    files: files.length,
    phrases: files.flatMap((f) => messagePhrases(rel(f), readFileSync(f, 'utf8'))),
  };
}

describe('#616 c13b (B): the command-name law', () => {
  it('every command the docs, the changelog and the product tell a person to type is one realm has', () => {
    const docs = docsClass();
    const product = productClass();
    const red = [...docs.phrases, ...product.phrases].flatMap((p) => {
      const why = judge(p.text);
      return why === undefined ? [] : [`${p.file}:${p.line} \`${p.text}\`: ${why}`];
    });
    console.log(
      `command-name law: docs ${docs.files} files, ${docs.phrases.length} phrases; product ${product.files} files, ${product.phrases.length} phrases; ${red.length} red`,
    );
    // (1) Can it fail: red when a doc names a command realm does not have (B2: `realm run gc`), when a
    //     product message's inner-backticked span does (B3: `realm db migrat ${x}` in a template), when
    //     the registry read is replaced by a hand list lacking a command (B5), and when a reader goes
    //     blind (a class with no file or no phrase).
    // (2) Prints: the files and phrases read per class, and every red phrase with its file, line and
    //     reason; on a pass, the counts.
    expect({
      docs: { files: docs.files > 0, phrases: docs.phrases.length > 0 },
      product: { files: product.files > 0, phrases: product.phrases.length > 0 },
      red,
    }).toEqual({
      docs: { files: true, phrases: true },
      product: { files: true, phrases: true },
      red: [],
    });
  });

  it('the reading rules, on one case each', () => {
    const md = [
      '`realm run gc` and ``realm db migrat`` and `realm run --help` and `npx realm run x`',
      '```bash',
      'realm runs --help',
      '  `realm workflow nope`',
      '```',
      'a span may wrap: `realm',
      'listen --port 1` (one paragraph), but `realm',
      '',
      'run x` crosses a blank line, so it never closes',
    ];
    const ts1 = [
      '// `realm run gc` in a comment is not a message',
      "const a = 'call `realm db migrat` first';",
      "const b = `realm run gc ${x}`; // the template's own delimiters",
      'const c = `see \\`realm run reclaim ${id} --step s\\``;',
      'const d = /`realm run gc`/;',
    ].join('\n');
    const log = [
      '## [Unreleased]',
      '### Removed',
      '- `realm run gc`',
      '### Fixed',
      '- `realm run drain`',
      '## [0.1.0]',
      '- `realm run gc`',
    ];
    // (1) Can it fail: red when a reading rule changes — a fenced line, a double-backtick span or a span
    //     wrapped inside its paragraph not read, a span read across a blank line, an unclosed span not
    //     kept for the judge, a comment or a template's delimiters or a regex literal read as a message,
    //     an inner backtick not read, the `### Removed` subsection or a released section read.
    // (2) Prints: the phrases each reader found, per case.
    expect({
      markdown: markdownPhrases('x.md', numbered(md.join('\n'))).map((p) => [p.line, p.text]),
      product: messagePhrases('x.ts', ts1).map((p) => [p.line, p.text]),
      changelog: markdownPhrases('CHANGELOG.md', unreleased(log.join('\n'))).map((p) => [
        p.line,
        p.text,
      ]),
    }).toEqual({
      markdown: [
        [1, 'realm run gc'],
        [1, 'realm db migrat'],
        [1, 'realm run --help'],
        [3, 'realm runs --help'],
        [6, 'realm listen --port 1'],
        [7, '`realm'],
      ],
      product: [
        [2, 'realm db migrat'],
        [4, 'realm run reclaim ${…} --step s'],
      ],
      changelog: [[5, 'realm run drain']],
    });
  });

  it('the judge, on the controls: a group alone is valid, a word that is no group is red, an unclosed span is red', () => {
    const cases = [
      'realm --help',
      'realm agent --profile p',
      'realm run --help',
      'realm db',
      'realm db check --json',
      'realm workflow run <path>',
      'realm runs --help',
      'realm run gc',
      'realm db migrat ${…}',
      '`realm',
    ];
    // (1) Can it fail: red when `realm <group>` alone stops being valid, when an unknown first word or
    //     an unknown subcommand stops being red, or when the registry loses a command named here.
    // (2) Prints: each phrase with its verdict.
    expect(cases.map((c) => [c, judge(c) ?? 'valid'])).toEqual([
      ['realm --help', 'valid'],
      ['realm agent --profile p', 'valid'],
      ['realm run --help', 'valid'],
      ['realm db', 'valid'],
      ['realm db check --json', 'valid'],
      ['realm workflow run <path>', 'valid'],
      ['realm runs --help', '"runs" is neither a command nor a group of realm'],
      ['realm run gc', '"gc" is not a command of realm run'],
      ['realm db migrat ${…}', '"migrat" is not a command of realm db'],
      ['`realm', 'the law cannot judge it: a span that does not close'],
    ]);
  });
});
