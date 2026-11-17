// test-support/changelog.ts — the CHANGELOG as a cycle's tests read it. A test written while a
// cycle is open pins its line under `## [Unreleased]`; the release renames that heading to the
// version, and the next cycle opens a new `## [Unreleased]` above it. A pin that reads one section
// goes red at one of those two moments (the 0.50.0 release pass, 2026-11-17: sixteen pins read
// `[Unreleased]` only and were red on the release branch; the first form of the fix re-broke when
// the next cycle opened). These read every section above the release before the cycle's own.
/** Every `## [...]` section above `## [<below>]`, newest first (`[Unreleased]` while a cycle is
 *  open, then the releases), each from its heading to the next; a missing `<below>` throws, so a
 *  typo cannot widen a pin to the whole file. */
export function changelogSectionsAbove(text: string, below: string): string[] {
  if (!text.includes(`\n## [${below}]`)) {
    throw new Error(`CHANGELOG.md has no section [${below}]`);
  }
  const sections: string[] = [];
  let at = text.indexOf('\n## [');
  while (at !== -1) {
    const next = text.indexOf('\n## [', at + 1);
    const section = next === -1 ? text.slice(at + 1) : text.slice(at + 1, next);
    if (section.startsWith(`## [${below}]`)) break;
    sections.push(section);
    at = next;
  }
  return sections;
}
/** A section's `### <heading>` part, to its next `### ` heading; '' when the section has none. */
export function changelogPart(section: string, heading: string): string {
  const start = section.indexOf(`### ${heading}`);
  if (start === -1) return '';
  const end = section.indexOf('\n### ', start + 1);
  return end === -1 ? section.slice(start) : section.slice(start, end);
}
/** The sections above `## [<below>]` joined — with a heading, each section's `### <heading>` part —
 *  for a pin that asks whether a line is there. A list that is numbered per section (Upgrading) is
 *  read per section, with `changelogSectionsAbove` and `changelogPart`. */
export function changelogAbove(text: string, below: string, heading?: string): string {
  const sections = changelogSectionsAbove(text, below);
  return (heading === undefined ? sections : sections.map((s) => changelogPart(s, heading))).join(
    '\n',
  );
}
