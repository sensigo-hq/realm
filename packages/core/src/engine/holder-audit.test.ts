// holder-audit.test.ts — issue #625 (the holder slice, PR-H): source-text witnesses. These pin the
// STRUCTURE of the change, where a behaviour cell cannot: that a vocabulary is declared once, that
// the claim's token leaves the engine through one door, that every place a program's code runs names
// the program, and that no carrier writes a sentence the core composes.
//
// They read production source only (test files are excluded), strip comments before matching, and
// parse call arguments with a string-aware balanced-paren scanner — a `//` inside a string or a `)`
// inside a template does not fool them. Each carries (a) the change that turns it red and (b) what
// it prints on failure: file names and counts, never file contents.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = join(fileURLToPath(new URL('../../../', import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every production source file of the three packages that reach operators. */
const FILES = ['core', 'cli', 'mcp-server', 'testing'].flatMap((p) =>
  walk(join(PACKAGES, p, 'src')),
);
const CORE_FILES = FILES.filter((f) => relative(PACKAGES, f).startsWith('core/'));
const rel = (f: string): string => relative(PACKAGES, f);

/** Source with comments blanked (newlines kept), string- and template-aware. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i]!;
          i++;
        }
        out += src[i] ?? '';
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const stripped = new Map(FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

/** The argument source of every call `<name>(…)` (not a declaration), top-level-comma split. */
function callsOf(src: string, nameRe: RegExp): string[][] {
  const calls: string[][] = [];
  const re = new RegExp(`(?<![\\w$])(?:[\\w$]+\\.)?${nameRe.source}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 24), m.index);
    // A declaration, not a call.
    if (/function\s+$/.test(before) || /async\s+$/.test(before)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let current = '';
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        current += c;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') {
            current += src[i]!;
            i++;
          }
          current += src[i] ?? '';
          i++;
        }
        current += quote;
        i++;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      if (depth === 0) break;
      if (c === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
      } else {
        current += c;
      }
      i++;
    }
    if (current.trim() !== '') args.push(current.trim());
    calls.push(args);
  }
  return calls;
}

describe('each vocabulary const is declared once, in one core file', () => {
  const CONSTS = [
    'BY_SOURCE_CLASSES',
    'ACTOR_ABSENT_CAUSES',
    'GATE_PROOFS',
    'GATE_PROOF_CAUSES',
    'CLAIM_PROOF_ABSENT_CAUSES',
  ];
  it.each(CONSTS)('%s', (name) => {
    const declaring = FILES.filter((f) =>
      new RegExp(`\\bexport const ${name}\\b`).test(stripped.get(f)!),
    );
    // (a) red when a second copy of the vocabulary appears (a carrier re-declares it); (b) prints
    //     the declaring files.
    expect(declaring.map(rel)).toEqual(['core/src/engine/holder.ts']);
  });
});

describe('the OS user is read at exactly two production sites', () => {
  it('userInfo( appears in the CLI helper and the realm-mcp bin — nowhere else (core reads no OS fact)', () => {
    const sites = FILES.filter((f) => /\buserInfo\s*\(/.test(stripped.get(f)!))
      .map(rel)
      .sort();
    // (a) red when core, or a third host, starts reading the OS user; (b) prints the files.
    expect(sites).toEqual(['cli/src/lib/program-identity.ts', 'mcp-server/src/server.ts']);
  });

  it("core reads no environment variable and no OS fact for a program's name (holder.ts imports nothing from node)", () => {
    const holder = stripped.get(join(PACKAGES, 'core/src/engine/holder.ts'))!;
    expect(holder).not.toMatch(/from\s+'node:/);
    expect(holder).not.toMatch(/process\.env/);
  });
});

describe('the claim token is passed back at exactly one non-test host site', () => {
  it('only the MCP tool passes claimToken into submitHumanResponse; no CLI surface does (it never passes one)', () => {
    const hosts = FILES.filter((f) => /^(cli|mcp-server)\//.test(rel(f)))
      .filter((f) => /\bclaimToken\b/.test(stripped.get(f)!))
      .map(rel);
    // (a) red when the CLI (respond, the run prompt, the Slack attendant) starts passing a token,
    //     or a second tool does; (b) prints the files.
    expect(hosts).toEqual(['mcp-server/src/tools/submit-human-response.ts']);
  });
});

describe("every place a program's code runs names the program (captureEvidence sites)", () => {
  // [file, sites passing drivenBy, engine-made sites] — each engine-made site with its reason. A NEW
  // `captureEvidence(` site fails this table until it is classified here.
  const TABLE: Array<[string, number, number, string]> = [
    [
      'core/src/engine/execution-loop.ts',
      10,
      3,
      'compensating un-claim line + the two answer entries (their person is `responded_by`)',
    ],
    [
      'core/src/engine/settlement.ts',
      0,
      7,
      "entries the settlement transform makes (an expiry, a guard, a release): no program's code ran",
    ],
    [
      'core/src/engine/reclaim-step.ts',
      0,
      1,
      "the reclaim audit line: the operator's act, not a step's work",
    ],
    ['cli/src/commands/drain.ts', 0, 1, "the --void line: an operator's act"],
  ];

  function sitesIn(file: string): string[][] {
    return callsOf(stripped.get(join(PACKAGES, file))!, /captureEvidence/);
  }

  it.each(TABLE)('%s: %i pass drivenBy, %i are engine-made (%s)', (file, passes, engineMade) => {
    const calls = sitesIn(file);
    const passing = calls.filter((c) => /\bdrivenBy\b/.test(c.join(',')));
    // (a) red when a site stops passing drivenBy (a program's work goes unnamed) or a new site
    //     appears unclassified; (b) prints both counts.
    expect([file, passing.length, calls.length - passing.length]).toEqual([
      file,
      passes,
      engineMade,
    ]);
  });

  it('no OTHER production file calls captureEvidence (the table is the whole set)', () => {
    const files = FILES.filter(
      (f) =>
        callsOf(stripped.get(f)!, /captureEvidence/).length > 0 &&
        !TABLE.some(([name]) => join(PACKAGES, name) === f) &&
        rel(f) !== 'core/src/evidence/snapshot.ts',
    ).map(rel);
    // cli/src/commands/drain.ts reaches it through deps.captureEvidence — covered by the table.
    expect(files).toEqual([]);
  });
});

describe('every call of drainFinalizers and buildFinalizedSeal passes a driver expression', () => {
  it('drainFinalizers: core passes options.driver / driver; the CLI passes deps.driver', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const f of FILES) {
      for (const args of callsOf(stripped.get(f)!, /drainFinalizers/)) {
        total += 1;
        const last = args[args.length - 1] ?? '';
        if (args.length < 5 || !/\bdriver\b/.test(last))
          offenders.push(`${rel(f)}: ${args.length} args`);
      }
    }
    // (a) red when ONE call site stops passing the driver (mutant i); (b) prints the offenders.
    expect(offenders).toEqual([]);
    // 10 in core + 3 in the CLI's drain (+ the expiry timer's one): the set is counted so a new
    // call site cannot slip in unexamined.
    expect(total).toBe(14);
  });

  it('buildFinalizedSeal: all six calls pass the driver as the fifth argument', () => {
    const calls = callsOf(
      stripped.get(join(PACKAGES, 'core/src/engine/execution-loop.ts'))!,
      /buildFinalizedSeal/,
    );
    expect(calls).toHaveLength(6);
    for (const args of calls) {
      expect(args).toHaveLength(5);
      expect(args[4]).toMatch(/\bdriver\b/);
    }
  });
});

describe('the sentences of the proof are composed in one core file and written in no carrier', () => {
  const SENTENCES = [
    'No claim_token was passed;',
    "The claim_token passed is not this question's;",
    'There is no claim to check a claim_token against',
    "This question's claim carries no token",
    'This store keeps no claims, so a claim_token cannot be checked',
    'The claim_token could not be checked: this question was already settled',
  ];
  it.each(SENTENCES)('%s', (sentence) => {
    const files = FILES.filter((f) => stripped.get(f)!.includes(sentence)).map(rel);
    // (a) red when a carrier (the CLI, an MCP tool) writes the sentence itself; (b) prints files.
    expect(files).toEqual(['core/src/engine/holder.ts']);
  });
});

describe('core imports nothing from a host package (the engine owns the vocabulary)', () => {
  it('holder.ts and the engine files import from core only', () => {
    for (const f of CORE_FILES) {
      expect(stripped.get(f)!).not.toMatch(/from\s+'@sensigo\/realm-(cli|mcp|testing)/);
    }
  });
});
