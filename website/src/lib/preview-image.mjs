// Draws the link-preview images (1200x630 PNG): the Realm logo, a line saying where the page sits,
// the page's title, and the site's address.
//
// Text is turned into vector outlines with opentype.js and the site's own font (IBM Plex Sans), and the
// drawing is then rendered by sharp. Nothing depends on the fonts installed on the machine that builds
// the site, so every build draws the same image.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as opentypeModule from 'opentype.js';
import sharp from 'sharp';
import { PREVIEW_SIZE } from './site-meta.mjs';

// opentype.js publishes CommonJS with a default export and an ES module without one; take either.
const opentype = opentypeModule.parse ? opentypeModule : opentypeModule.default;

const require = createRequire(import.meta.url);
function loadFont(weight) {
  const file = require.resolve(
    `@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff`,
  );
  const bytes = readFileSync(file);
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const FONT = { regular: loadFont(400), medium: loadFont(500), semibold: loadFont(600) };

// The dark palette (src/styles/palette.css): link previews are shown on light and dark screens alike,
// and the dark one is the site's default.
const COLOR = {
  bg: '#07111f',
  ink: '#f4f8fc',
  body: '#c6d6e6',
  muted: '#93aac2',
  accent: '#5ee6c1',
};

// The brand kit's lockup (brand-kit/logo/realm-lockup-on-dark.svg, the same paths as
// src/components/Logo.astro): the R in a 208.417 x 47.68 box with the wordmark.
const LOCKUP = {
  width: 208.417,
  height: 47.68,
  mark: 'M0 0 H21 V57.4 H0 Z M21 0 H59 A28.7 28.7 0 0 1 59 57.4 H21 V39.4 H59 A7.7 10.7 0 0 0 59 18 H21 Z M0 69.1 H21 V100 H0 Z M36 69.1 L64 69.1 L90 100 L62 100 Z',
  markTransform: 'translate(2 2) scale(0.437)',
  word: 'M62.593250000000005 45.68H69.97606250000001V28.16046875C69.97606250000001 23.326484375 72.70067187500001 20.89484375 76.21629687500001 20.89484375C77.68114062500001 20.89484375 79.14598437500001 21.041328125 79.70262500000001 21.12921875V14.56671875C79.11668750000001 14.508125 78.29637500000001 14.44953125 77.30028125000001 14.44953125C73.31590625000001 14.44953125 70.94285937500001 16.32453125 69.80028125000001 19.869453125H69.71239062500001V14.7425H62.593250000000005Z M95.72215625000001 46.383125C102.95848437500001 46.383125 108.70067187500001 42.193671875 109.87254687500001 36.12921875H102.95848437500001C102.10887500000001 38.7659375 99.61864062500001 40.553046875 95.89793750000001 40.553046875C90.91746875000001 40.553046875 88.04637500000001 37.18390625 87.87059375000001 32.14484375H110.25340625000001V30.123359375C110.25340625000001 20.631171875 104.33543750000001 14.039375 95.42918750000001 14.039375C86.75731250000001 14.039375 80.63426562500001 20.83625 80.63426562500001 30.240546875C80.63426562500001 39.615546875 86.43504687500001 46.383125 95.72215625000001 46.383125ZM87.92918750000001 27.0471875C88.42723437500001 22.623359375 91.26903125000001 19.89875 95.54637500000001 19.89875C99.82371875000001 19.89875 102.69481250000001 22.623359375 103.16356250000001 27.0471875Z M123.60692187500001 46.178046875C128.645984375 46.178046875 131.25340625 44.068671875 132.71825 41.314765625H132.8354375V45.68H140.1010625V24.58625C140.1010625 18.1409375 135.325671875 14.127265625 127.26903125000001 14.127265625C119.18309375000001 14.127265625 114.14403125000001 18.19953125 113.79246875000001 24.351875H120.91160937500001C121.11668750000001 21.744453125 123.51903125000001 19.869453125 127.12254687500001 19.869453125C130.66746875 19.869453125 132.77684375 21.744453125 132.77684375 24.381171875V24.615546875C132.77684375 26.724921875 130.813953125 26.8128125 125.07176562500001 27.45734375C118.68504687500001 28.131171875 112.91356250000001 29.8596875 112.91356250000001 36.8909375C112.91356250000001 43.072578125 117.45457812500001 46.178046875 123.60692187500001 46.178046875ZM125.42332812500001 40.69953125C122.20067187500001 40.69953125 120.12059375000001 39.263984375 120.12059375000001 36.83234375C120.12059375000001 34.01984375 122.81590625000001 32.877265625 125.97996875000001 32.408515625C129.02684375 31.939765625 131.8979375 31.471015625 132.806140625 30.885078125V34.224921875C132.806140625 37.8284375 130.2573125 40.69953125 125.42332812500001 40.69953125Z M152.517078125 2.0276562499999997H145.134265625V45.68H152.517078125Z M157.579578125 45.68H164.962390625V27.22296875C164.962390625 22.799140625 167.8041875 20.396796875 171.14403125 20.396796875C174.42528125 20.396796875 176.76903125 22.5940625 176.76903125 25.963203125V45.68H183.946765625V26.695625C183.946765625 23.00421875 186.26121875 20.396796875 190.01121875 20.396796875C193.17528125 20.396796875 195.75340625 22.213203125 195.75340625 26.314765625V45.68H203.165515625V25.260078125C203.165515625 17.994453125 198.653796875 14.127265625 192.794421875 14.127265625C188.282703125 14.127265625 184.591296875 16.412421875 182.950671875 19.986640625C181.661609375 16.44171875 178.233875 14.127265625 174.044421875 14.127265625C170.1479375 14.127265625 166.603015625 16.119453125 164.728015625 20.103828125V14.7425H157.579578125Z',
};

const MARGIN = 80;
const TEXT_WIDTH = PREVIEW_SIZE.width - 2 * MARGIN;

/** Throws when the font has no glyph for a character, instead of drawing an empty box in its place. */
function assertDrawable(font, text) {
  const missing = [
    ...new Set([...text].filter((ch) => ch.trim() !== '' && font.charToGlyph(ch).index === 0)),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Preview image: the font has no glyph for ${missing.map((c) => JSON.stringify(c)).join(', ')} in "${text}"`,
    );
  }
}

/** Splits text into lines no wider than `width` at `size`, breaking between words. */
function wrap(font, text, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.getAdvanceWidth(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// opentype.js's own Path.toPathData is not used: in 2.0.0 its rounding writes some coordinates as NaN
// (224.00000000000003 came out as "NaN"), and the renderer stops drawing at the first NaN.
function coordinate(v) {
  if (!Number.isFinite(v))
    throw new Error(`Preview image: a glyph outline has the coordinate ${v}`);
  return String(Math.round(v * 100) / 100);
}
function pathData(path) {
  return path.commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${coordinate(c.x)} ${coordinate(c.y)}`;
        case 'Q':
          return `Q${coordinate(c.x1)} ${coordinate(c.y1)} ${coordinate(c.x)} ${coordinate(c.y)}`;
        case 'C':
          return `C${[c.x1, c.y1, c.x2, c.y2, c.x, c.y].map(coordinate).join(' ')}`;
        case 'Z':
          return 'Z';
        default:
          throw new Error(`Preview image: unknown path command ${c.type}`);
      }
    })
    .join('');
}

/** The text as one filled path, its first baseline at `y`. */
function textPath(font, lines, { x, y, size, lineHeight, color }) {
  const d = lines
    .map((line, i) => pathData(font.getPath(line, x, y + i * size * lineHeight, size)))
    .join('');
  return `<path fill="${color}" d="${d}"/>`;
}

function lockup(x, y, height) {
  const scale = height / LOCKUP.height;
  return `<g transform="translate(${x} ${y}) scale(${scale})">
  <path fill="${COLOR.accent}" transform="${LOCKUP.markTransform}" d="${LOCKUP.mark}"/>
  <path fill="${COLOR.ink}" d="${LOCKUP.word}"/>
</g>`;
}

function frame(content) {
  const { width, height } = PREVIEW_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${COLOR.bg}"/>
<rect x="0" y="${height - 10}" width="${width}" height="10" fill="${COLOR.accent}"/>
${content}
${textPath(FONT.medium, ['realmengine.dev'], { x: MARGIN, y: height - 64, size: 28, lineHeight: 1, color: COLOR.muted })}
</svg>`;
}

const TITLE_SIZES = [68, 60, 54, 48];
const TITLE_MAX_LINES = 3;

/** The image for one docs page: the logo, where the page sits, and its title. */
export async function docsPreviewPng({ eyebrow, title }) {
  assertDrawable(FONT.medium, eyebrow);
  assertDrawable(FONT.semibold, title);
  let size;
  let lines;
  for (size of TITLE_SIZES) {
    lines = wrap(FONT.semibold, title, size, TEXT_WIDTH);
    if (lines.length <= TITLE_MAX_LINES) break;
  }
  if (lines.length > TITLE_MAX_LINES) {
    throw new Error(`Preview image: "${title}" does not fit in ${TITLE_MAX_LINES} lines`);
  }
  // Eyebrow baseline at 200; the title's first baseline one title line below it. Three lines at the
  // largest size end about 70px above the footer.
  const svg = frame(`${lockup(MARGIN, 72, 52)}
${textPath(FONT.medium, [eyebrow], { x: MARGIN, y: 200, size: 30, lineHeight: 1, color: COLOR.accent })}
${textPath(FONT.semibold, lines, { x: MARGIN, y: 200 + 30 + size, size, lineHeight: 1.18, color: COLOR.ink })}`);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The image for the home and how-it-works pages: the logo and the site's two-line summary. */
export async function sitePreviewPng({ headline, subline }) {
  assertDrawable(FONT.semibold, headline);
  assertDrawable(FONT.regular, subline);
  // Each sentence on one line: the largest size at which it fits.
  const fit = (font, text, sizes) => {
    const size = sizes.find((s) => font.getAdvanceWidth(text, s) <= TEXT_WIDTH);
    if (size === undefined) throw new Error(`Preview image: "${text}" does not fit on one line`);
    return size;
  };
  const headSize = fit(FONT.semibold, headline, [56, 52, 48, 44]);
  const subSize = fit(FONT.regular, subline, [36, 34, 32, 30]);
  const svg = frame(`${lockup(MARGIN, 96, 104)}
${textPath(FONT.semibold, [headline], { x: MARGIN, y: 340, size: headSize, lineHeight: 1, color: COLOR.ink })}
${textPath(FONT.regular, [subline], { x: MARGIN, y: 412, size: subSize, lineHeight: 1, color: COLOR.body })}`);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
