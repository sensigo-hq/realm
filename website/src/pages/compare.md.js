// /compare.md: the comparison as Markdown, for AI agents and other programs that read text rather than
// HTML. It is built from the same data (src/lib/comparison.mjs) and the same sentences
// (src/lib/compare-text.mjs) as the page, so the two say the same thing. The page names it in a
// <link rel="alternate" type="text/markdown">, llms.txt links to it, and the server returns it for
// /compare/ when a request asks for Markdown (website/deploy/nginx-site.conf). Links are full addresses.
import { tools, rows, facts, strengths } from '../lib/comparison.mjs';
import {
  VERDICT_LABEL,
  verdictGroups,
  LABEL_MEANINGS,
  pageTitle,
  checkedRange,
  lede,
  difference,
  orderLine,
  tableHeading,
  partialNote,
  toolsIntro,
  howChecked,
  linkParts,
  issueLink,
} from '../lib/compare-text.mjs';
import { absolute } from '../lib/site-meta.mjs';

// A table cell holds one line, and a "|" would end it.
const cell = (text) =>
  String(text)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
const withIssueLinks = (text) =>
  linkParts(text)
    .map((p) => (p.issue ? `[#${p.issue}](${issueLink(p.issue)})` : p.text))
    .join('');
const line = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, body) =>
  [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');

export function GET() {
  const names = tools.map((t) => t.name);
  const out = [
    `# ${pageTitle}`,
    '',
    `Checked ${checkedRange}. This is the Markdown copy of ${absolute('/compare/')}.`,
    '',
    lede,
    '',
    difference,
    '',
    '## Summary',
    '',
    ...verdictGroups.map((g) => `- **${g.label}:** ${g.rows.map((r) => r.title).join('; ')}`),
    '',
    `## ${tableHeading}`,
    '',
    `${orderLine} ${partialNote}`,
    '',
    table(
      ['Question', ...names],
      rows.map((r) => [
        `${cell(r.title)} (${VERDICT_LABEL[r.verdict.kind]})`,
        ...tools.map((t) => r.cells[t.key].value),
      ]),
    ),
    '',
    table(
      ['Fact', ...names],
      facts.map((f) => [cell(f.title), ...tools.map((t) => cell(f.cells[t.key]))]),
    ),
    '',
    '## Every answer, with its source',
    '',
    `Each source says how it was checked: ${LABEL_MEANINGS.map(([lab, meaning]) => `${lab} ${meaning}`).join(', ')}.`,
    '',
  ];
  for (const r of rows) {
    out.push(
      `### ${r.title}`,
      '',
      `The question: ${r.ask}`,
      '',
      `**${VERDICT_LABEL[r.verdict.kind]}.** ${withIssueLinks(r.verdict.text)}`,
      '',
      table(
        ['Tool', 'Answer', 'What it does', 'Source'],
        tools.map((t) => {
          const c = r.cells[t.key];
          return [t.name, c.value, cell(withIssueLinks(c.note)), cell(`${c.label}: ${c.source}`)];
        }),
      ),
      '',
    );
  }
  out.push(
    '## What each one does better, and where it falls short',
    '',
    toolsIntro,
    '',
    table(
      ['Tool', 'Kind', 'Release checked', 'Stronger at', 'Weaker at'],
      tools.map((t) => [
        t.name,
        t.group,
        `${t.version}, on ${t.checked}`,
        cell(withIssueLinks(strengths[t.key].stronger)),
        cell(withIssueLinks(strengths[t.key].weaker)),
      ]),
    ),
    '',
    '## How this was checked',
    '',
    ...howChecked.map(
      (item) =>
        `- ${item.map((p) => (typeof p === 'string' ? p : `[${p.text}](${p.href})`)).join('')}`,
    ),
    '',
  );
  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
