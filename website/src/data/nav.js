// Shared top-nav links for every standalone (non-Starlight) page: index.astro and
// how-it-works.astro. One source so a link added to one page is never missing from the other.
export const nav = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/docs/', label: 'Docs' },
  { href: 'https://github.com/sensigo-hq/realm', label: 'GitHub' },
  { href: 'https://www.npmjs.com/package/@sensigo/realm', label: 'npm' },
];
