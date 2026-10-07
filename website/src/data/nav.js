// The site menu's links, for every page: the home, how-it-works and comparison pages show them through
// src/components/SiteNav.astro, the docs pages through src/components/DocsHeaderLinks.astro. One source,
// so a link added for one page is never missing from another. `icon` names a Starlight icon: the docs
// header shows that link as the icon alone on a wide screen, where five words do not fit beside the
// search box.
export const nav = [
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/compare/', label: 'Compare' },
  { href: '/docs/', label: 'Docs' },
  { href: 'https://github.com/sensigo-hq/realm', label: 'GitHub', icon: 'github' },
  { href: 'https://www.npmjs.com/package/@sensigo/realm', label: 'npm', icon: 'npm' },
];
