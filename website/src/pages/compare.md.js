// /compare.md: the comparison as Markdown, for AI agents and other programs that read text rather than
// HTML. It is built from the same data (src/lib/comparison.mjs) and the same sentences and headings
// (src/lib/compare-text.mjs) as the page, so the two state the same facts. Only the page has its
// layout text: the menu, the small labels above the headings, the per-question tallies (which regroup
// the answers) and the footer. The page names it in a
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
  HEADINGS,
} from '../lib/compare-text.mjs';
import { absolute } from '../lib/site-meta.mjs';

// Every text taken from the data or the page's sentences goes through esc, so it reads as the same
// words in Markdown: a backslash, the characters that would start emphasis, code, a link or raw HTML
// (run_<key> would otherwise be a tag), and "|", which would end a table cell, are escaped. An
// underscore between two letters or digits (execute_step) cannot start emphasis in CommonMark, so it is
// left as it is; one next to anything else (configs/feature/__init__.py) is escaped.
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const esc = (text) =>
  String(text)
    .replace(/[\\`*[\]<>|]/g, '\\$&')
    .replace(/_+/g, (run, at, all) =>
      LETTER_OR_DIGIT.test(all[at - 1] ?? '') && LETTER_OR_DIGIT.test(all[at + run.length] ?? '')
        ? run
        : '\\_'.repeat(run.length),
    );
// A table cell holds one line. Its text is already escaped by esc.
const cell = (markdown) => markdown.replace(/\s*\n\s*/g, ' ');
const withIssueLinks = (text) =>
  linkParts(text)
    .map((p) => (p.issue ? `[#${p.issue}](${issueLink(p.issue)})` : esc(p.text)))
    .join('');
const link = (text, href) => `[${esc(text)}](${href})`;
const line = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, body) =>
  [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');

export function GET() {
  const names = tools.map((t) => esc(t.name));
  const out = [
    `# ${esc(pageTitle)}`,
    '',
    `Checked ${esc(checkedRange)}. This is the Markdown copy of ${absolute('/compare/')}.`,
    '',
    esc(lede),
    '',
    esc(difference),
    '',
    '## Summary',
    '',
    ...verdictGroups.map(
      (g) => `- **${esc(g.label)}:** ${g.rows.map((r) => esc(r.title)).join('; ')}`,
    ),
    '',
    `## ${esc(tableHeading)}`,
    '',
    `${esc(orderLine)} ${esc(partialNote)}`,
    '',
    table(
      ['Question', ...names],
      rows.map((r) => [
        `${esc(r.title)} (${esc(VERDICT_LABEL[r.verdict.kind])})`,
        ...tools.map((t) => esc(r.cells[t.key].value)),
      ]),
    ),
    '',
    table(
      ['Fact', ...names],
      facts.map((f) => [cell(esc(f.title)), ...tools.map((t) => cell(esc(f.cells[t.key])))]),
    ),
    '',
    `## ${esc(HEADINGS.answers)}`,
    '',
    `Each source says how it was checked: ${LABEL_MEANINGS.map(([lab, meaning]) => `${esc(lab)} ${esc(meaning)}`).join(', ')}.`,
    '',
  ];
  for (const r of rows) {
    out.push(
      `### ${esc(r.title)}`,
      '',
      `The question: ${esc(r.ask)}`,
      '',
      `**${esc(VERDICT_LABEL[r.verdict.kind])}.** ${withIssueLinks(r.verdict.text)}`,
      '',
      table(
        ['Tool', 'Answer', 'What it does', 'Source'],
        tools.map((t) => {
          const c = r.cells[t.key];
          return [
            esc(t.name),
            esc(c.value),
            cell(withIssueLinks(c.note)),
            cell(esc(`${c.label}: ${c.source}`)),
          ];
        }),
      ),
      '',
    );
  }
  out.push(
    `## ${esc(HEADINGS.tools)}`,
    '',
    esc(toolsIntro),
    '',
    table(
      ['Tool', 'Kind', 'Release checked', 'Stronger at', 'Weaker at'],
      tools.map((t) => [
        esc(t.name),
        esc(t.group),
        esc(`${t.version}, on ${t.checked}`),
        cell(withIssueLinks(strengths[t.key].stronger)),
        cell(withIssueLinks(strengths[t.key].weaker)),
      ]),
    ),
    '',
    `## ${esc(HEADINGS.how)}`,
    '',
    ...howChecked.map(
      (item) =>
        `- ${item.map((p) => (typeof p === 'string' ? esc(p) : link(p.text, p.href))).join('')}`,
    ),
    '',
  );
  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
