// The line under each docs page's title that says which Realm the docs describe (the page heading,
// src/components/DocsPageTitle.astro; the Markdown copies, src/pages/[...slug].md.js).
//
// The deploy build (scripts/deploy-build.mjs) builds the docs from the newest release's branch
// docs/v<version> and passes that version in REALM_DOCS_VERSION, taken from the release tag. Any other
// build (CI, `npm run dev`, a plain `npm run build`) reads the checkout's docs, so its line says so.
// The number is never read from a package file: between releases main's packages carry a development
// version (0.49.1-dev.0 after 0.49.0).

const TAGS_URL = 'https://github.com/sensigo-hq/realm/tags';
const MAIN_DOCS_URL = 'https://github.com/sensigo-hq/realm/tree/main/docs';

/** The version the docs describe, or null when they are the checkout's (not a release's). */
export function docsVersion() {
  const v = process.env.REALM_DOCS_VERSION;
  if (v === undefined || v === '') return null;
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`REALM_DOCS_VERSION is "${v}", not a release version such as 0.49.0`);
  }
  return v;
}

/** The line as parts: plain text, or `{ text, href }` for a link. */
export function docsVersionParts() {
  const v = docsVersion();
  return v
    ? [
        `These docs describe Realm ${v}, the latest release. Docs for `,
        { text: 'older versions', href: TAGS_URL },
        ', and for ',
        { text: 'the next one', href: MAIN_DOCS_URL },
        ', are on GitHub.',
      ]
    : [
        'These docs describe Realm as it is on the main branch, not a release. ',
        { text: "Each release's docs", href: TAGS_URL },
        ' are on GitHub.',
      ];
}

/** The line in Markdown, with full addresses, for the Markdown copies. */
export function docsVersionMarkdown() {
  return docsVersionParts()
    .map((p) => (typeof p === 'string' ? p : `[${p.text}](${p.href})`))
    .join('');
}
