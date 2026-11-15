// store-check-forms.ts — the filter-mask fix, PR 2 (`realm db check --project <dir>`): the check's scan
// for the CHANGED forms of the declared values a caller passes in (the project's `${secret:NAME}`
// values). Before the fix, a template that showed a declared value through a filter stored the
// filtered form: the mask ran after the filter and knew only the exact forms. This scan names each
// stored place that holds such a form, so the operator rotates those secrets and purges those runs.
//
// The forms (one finite set, from the filters that change a string's text without making new text):
// for each declared value of {@link DECLARED_FORM_MIN} characters or more, its upper-cased,
// lower-cased, capitalised (the first character upper, as `capitalize` does) and title-cased (the
// first character of each run of non-space characters upper, as `title` does) forms, each only when it
// differs from the value; and its truncated forms, `<prefix>…`: a prefix of 8 … length−1 characters
// of the value or of one of its case forms, followed by the `truncate` filter's marker `…` (U+2026; the
// filter always appends it when it cuts). A bare prefix is not a form: every value holds all its
// prefixes. A form equal to one already made is kept once, under the first kind in
// {@link FORM_KINDS}' order. `replace` and `split` make fragments that cannot be listed; a shorter
// value makes no form: the check lists both as not checked.
//
// The scan reads, in ONE read transaction on the check's read-only connection, every column that
// holds rendered text: `runs.record`, `evidence.entry`, `run_blobs.value`, `trace_buffer.entries`,
// `trace_sealed.lines` and `failed_attempts.line`, each table paged by rowid. A JSON column is parsed
// and each string in it (every value and every key) is searched; a column that is not JSON is searched
// as one string. In each string, the raw values are found first and their places are never a hit (the
// store keeps execution values raw by design: every run that handled a value holds it); then the
// forms, longest first, a place matched once not matched again. A hit is one place × one kind; it
// carries the run, the field and the kind, never the value or the form. The values never leave this
// module: they are not stored, not logged and not in any error.

import type { DatabaseLike } from './driver.js';

/** The shortest declared value that makes forms: the mask's own floor (core's `MIN_FORM_LENGTH`, in
 *  `redaction-variants.ts`, which the package does not export). */
export const DECLARED_FORM_MIN = 8;

/** The kinds of form, in the order a form equal to another is named. */
export const FORM_KINDS = [
  'upper-cased',
  'lower-cased',
  'capitalised',
  'title-cased',
  'truncated',
] as const;
/** A kind of changed form. */
export type FormKind = (typeof FORM_KINDS)[number];

/** The `truncate` filter's marker, which it appends whenever it cuts. */
const TRUNCATED = '…';

/** One stored place that holds a changed form: its run, the field, and the kind. */
export interface FormHit {
  readonly runId: string;
  readonly path: string;
  readonly kind: FormKind;
}

/** The forms to look for: the case forms, and the bases each truncated form is a prefix of. */
interface Forms {
  /** The declared values themselves (8 characters or more): their places are never a hit. */
  readonly raws: readonly string[];
  /** The case forms, longest first, each with its kind. */
  readonly cases: readonly { readonly text: string; readonly kind: FormKind }[];
  /** The strings whose prefixes, followed by the marker, are truncated forms: each value and its
   *  case forms, longest first. */
  readonly bases: readonly string[];
}

const capitalised = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const titleCased = (value: string): string =>
  value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));

/** The forms of `values` (see the module comment). */
function formsOf(values: readonly string[]): Forms {
  const raws = [...new Set(values.filter((value) => value.length >= DECLARED_FORM_MIN))];
  const rawSet = new Set(raws);
  const seen = new Set<string>(raws);
  const cases: { text: string; kind: FormKind }[] = [];
  const bases = new Set<string>();
  for (const value of raws) {
    bases.add(value);
    const made: readonly [FormKind, string][] = [
      ['upper-cased', value.toUpperCase()],
      ['lower-cased', value.toLowerCase()],
      ['capitalised', capitalised(value)],
      ['title-cased', titleCased(value)],
    ];
    for (const [kind, text] of made) {
      bases.add(text);
      if (seen.has(text) || rawSet.has(text)) continue;
      seen.add(text);
      cases.push({ text, kind });
    }
  }
  // Longest first; equal lengths keep FORM_KINDS' order (the sort is stable).
  cases.sort((a, b) => b.text.length - a.text.length);
  return { raws, cases, bases: [...bases].sort((a, b) => b.length - a.length) };
}

/** The kinds a string holds (see the module comment), in {@link FORM_KINDS}' order. */
function kindsIn(text: string, forms: Forms): FormKind[] {
  const taken: [number, number][] = [];
  const free = (start: number, end: number): boolean =>
    taken.every(([s, e]) => end <= s || start >= e);
  const each = (needle: string, found: (start: number) => void): void => {
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found(at);
  };
  for (const raw of forms.raws) {
    each(raw, (at) => {
      if (free(at, at + raw.length)) taken.push([at, at + raw.length]);
    });
  }
  const kinds = new Set<FormKind>();
  // Longest first: the case forms are as long as their value, a truncated form at most as long.
  for (const { text: form, kind } of forms.cases) {
    each(form, (at) => {
      if (!free(at, at + form.length)) return;
      taken.push([at, at + form.length]);
      kinds.add(kind);
    });
  }
  each(TRUNCATED, (marker) => {
    if (!free(marker, marker + 1)) return;
    // The longest prefix of a base that ends at the marker, of 8 characters or more.
    let longest = 0;
    for (const base of forms.bases) {
      for (
        let n = Math.min(base.length - 1, marker);
        n >= DECLARED_FORM_MIN && n > longest;
        n -= 1
      ) {
        if (text.startsWith(base.slice(0, n), marker - n)) {
          longest = n;
          break;
        }
      }
    }
    if (longest === 0 || !free(marker - longest, marker + 1)) return;
    taken.push([marker - longest, marker + 1]);
    kinds.add('truncated');
  });
  return FORM_KINDS.filter((kind) => kinds.has(kind));
}

/** Each string of a parsed JSON value (every value and every key), with its path under `path`. */
function strings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => strings(item, `${path}[${String(i)}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const at = path === '' ? key : `${path}.${key}`;
      out.push({ path: at, text: key });
      strings(item, at, out);
    }
  }
}

/** A column's text: its strings with their paths when it is JSON, else the text itself at `''`. */
function stringsOf(text: string): { path: string; text: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ path: '', text }];
  }
  const out: { path: string; text: string }[] = [];
  strings(parsed, '', out);
  return out;
}

/** One table's column: how its rows are read, and how a row's place is named. */
interface Source {
  readonly table: string;
  /** The columns read besides the scanned one. */
  readonly columns: string;
  readonly scanned: string;
  readonly runOf: (row: Record<string, unknown>) => string;
  /** The place: `inner` is the string's JSON path within the column (`''` for the whole). */
  readonly placeOf: (row: Record<string, unknown>, inner: string) => string;
}

const joined = (head: string, inner: string): string => (inner === '' ? head : `${head}: ${inner}`);

/** The columns that hold rendered text, in the order they are scanned and reported. */
const SOURCES: readonly Source[] = [
  {
    table: 'runs',
    columns: 'id',
    scanned: 'record',
    runOf: (row) => String(row['id']),
    placeOf: (_row, inner) => (inner === '' ? 'record' : inner),
  },
  {
    table: 'evidence',
    columns: 'run_id, seq',
    scanned: 'entry',
    runOf: (row) => String(row['run_id']),
    placeOf: (row, inner) => joined(`evidence seq ${String(row['seq'])}`, inner),
  },
  {
    table: 'run_blobs',
    columns: 'run_id, name',
    scanned: 'value',
    runOf: (row) => String(row['run_id']),
    placeOf: (row) => `run_blobs ${String(row['name'])}`,
  },
  {
    table: 'trace_buffer',
    columns: 'run_id, step_id, line_seq',
    scanned: 'entries',
    runOf: (row) => String(row['run_id']),
    placeOf: (row) => `trace_buffer ${String(row['step_id'])} line ${String(row['line_seq'])}`,
  },
  {
    table: 'trace_sealed',
    columns: 'run_id, step_id, seal_seq',
    scanned: 'lines',
    runOf: (row) => String(row['run_id']),
    placeOf: (row) => `trace_sealed ${String(row['step_id'])} seal ${String(row['seal_seq'])}`,
  },
  {
    table: 'failed_attempts',
    columns: 'run_id, seq',
    scanned: 'line',
    runOf: (row) => String(row['run_id']),
    placeOf: (row) => `failed_attempts seq ${String(row['seq'])}`,
  },
];

/** How many rows one page of a table reads. */
const FORMS_PAGE = 500;

/**
 * The scan (see the module comment), inside the caller's read transaction on connection `c`. Throws
 * what the driver throws (the data pass's `scan` judges it). A store whose values are all shorter
 * than {@link DECLARED_FORM_MIN} reads nothing.
 */
export function scanDeclaredForms(c: DatabaseLike, values: readonly string[]): FormHit[] {
  const forms = formsOf(values);
  const hits: FormHit[] = [];
  if (forms.raws.length === 0) return hits;
  // One hit per place and kind: a key and its value share a path.
  const seen = new Set<string>();
  for (const source of SOURCES) {
    const select = (where: string): string =>
      `SELECT rowid AS r, ${source.columns}, ${source.scanned} AS t FROM ${source.table} ${where} ORDER BY rowid LIMIT ?`;
    const next = c.prepare(select('WHERE rowid > ?'));
    let page = c.prepare(select('')).all(FORMS_PAGE);
    while (page.length > 0) {
      for (const row of page) {
        if (typeof row['t'] !== 'string') continue;
        const runId = source.runOf(row);
        for (const { path, text } of stringsOf(row['t'])) {
          for (const kind of kindsIn(text, forms)) {
            const place = source.placeOf(row, path);
            const key = JSON.stringify([runId, place, kind]);
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({ runId, path: place, kind });
          }
        }
      }
      if (page.length < FORMS_PAGE) break;
      page = next.all(page[page.length - 1]!['r'], FORMS_PAGE);
    }
  }
  return hits;
}
