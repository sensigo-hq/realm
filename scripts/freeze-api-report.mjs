#!/usr/bin/env node
// freeze-api-report.mjs — CP-1: writes the frozen copy of an API report, the last release's tagged
// rows, which the changelog cell of `packages/core/src/inventory/api-report.test.ts` compares the
// live report with. Release step 2 runs it per package:
//
//   node scripts/freeze-api-report.mjs packages/core/src/inventory/api-report.txt 'frozen at v<version>'
//
// It writes `api-report.frozen.txt` beside the report: the header `# <header>`, the report's section
// headings, and one line per tagged row (`@public` or `@beta`; an internal row has no promise to
// keep): `name · kind · tag · hash`, the hash being the first 10 hex characters of the sha256 of the
// row's block as the report prints it (its header line and its indented lines, joined by "\n"). The
// test computes the same hash (a cell of the test checks the two agree).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The frozen copy's text for the report `report`, headed `# <header>`. */
export function frozenText(report, header) {
  const out = [
    `# ${header}`,
    '# The tagged rows of an API report as of that release: name · kind · tag · the first 10 hex',
    "# characters of the sha256 of the row's block. Written by scripts/freeze-api-report.mjs; the",
    '# changelog cell of packages/core/src/inventory/api-report.test.ts compares the live report with it.',
  ];
  let cur;
  const flush = () => {
    if (cur === undefined) return;
    const [name, kind, tag] = cur.head.split(' · ');
    if (!tag.startsWith('internal')) {
      const hash = createHash('sha256')
        .update([cur.head, ...cur.lines].join('\n'), 'utf8')
        .digest('hex')
        .slice(0, 10);
      out.push(`${name} · ${kind} · ${tag} · ${hash}`);
    }
    cur = undefined;
  };
  for (const line of report.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      out.push('', line);
      continue;
    }
    if (line.startsWith('#') || line === '') {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('  ') && cur !== undefined) cur.lines.push(line);
    else {
      flush();
      cur = { head: line, lines: [] };
    }
  }
  flush();
  return `${out.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [report, header] = process.argv.slice(2);
  if (report === undefined || header === undefined || !report.endsWith('.txt')) {
    process.stderr.write(
      "usage: node scripts/freeze-api-report.mjs <api-report.txt> 'frozen at v<version>'\n",
    );
    process.exit(2);
  }
  const target = report.replace(/\.txt$/, '.frozen.txt');
  writeFileSync(target, frozenText(readFileSync(report, 'utf8'), header));
  process.stdout.write(`wrote ${target}\n`);
}
