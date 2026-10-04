// The site's icons, from the brand kit (brand-kit/favicon/, files in public/).
// One list, used by the home and how-it-works pages directly and by the docs through astro.config.mjs.
//
// favicon.svg  - modern browsers; deep verdigris in a light browser tab, verdigris in a dark one
//                (it follows the BROWSER's theme, which is what the tab bar follows - not the site's switch)
// favicon.ico  - 16, 32 and 48 in one file, for browsers that do not read SVG icons
// apple-touch-icon.png, site.webmanifest (-> icon-192, icon-512, icon-maskable-512) - home screens
// The .ico is declared 48x48 so that Chrome takes the SVG instead of it.
export const ICON_LINKS = [
  { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'manifest', href: '/site.webmanifest' },
];

// The navy of the site, also the manifest's theme_color. Mobile browsers tint their bar with it.
export const THEME_COLOR = '#07111F';
