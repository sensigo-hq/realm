// node_capture.mjs — Node's default printers over the FAKE inputs named on the command line (a JSON
// object: case id -> value). One JSON line per (printer, case): {"p", "c", "out"}.
/* global Buffer, console, process, URLSearchParams */
import { readFileSync } from 'node:fs';
import util from 'node:util';
import querystring from 'node:querystring';
import yaml from 'js-yaml';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));

/** An Error's `cause` as `util.inspect` prints it: the whole `[cause]` block, stack frames dropped. */
function causeBlock(s) {
  const lines = util.inspect(new Error('x', { cause: { k: s } })).split('\n');
  const start = lines.findIndex((line) => line.includes('[cause]'));
  return lines
    .slice(start)
    .filter((line) => !/^\s+at /.test(line))
    .join('\n');
}

const printers = {
  'node.JSON.stringify': (s) => JSON.stringify(s),
  // A program that reads the value's JSON escapes before printing it (a key written on one line with
  // `\n`, read from a JSON file): D's producer. A value that is not a JSON string's inside throws.
  'node.JSON.parse_str': (s) => JSON.parse('"' + s + '"'),
  'node.inspect_str': (s) => util.inspect(s),
  'node.inspect_obj': (s) => util.inspect({ k: s }),
  'node.format_o': (s) => util.format('%o', s),
  'node.format_j_obj': (s) => util.format('%j', { k: s }),
  'node.inspect_err_cause': causeBlock,
  'node.encodeURIComponent': (s) => encodeURIComponent(s),
  'node.encodeURI': (s) => encodeURI(s),
  // Excluded from the fixture by name (problem 11: legacy `escape()` is not a printer default).
  'node.escape_legacy': (s) => escape(s),
  'node.URLSearchParams': (s) => new URLSearchParams({ k: s }).toString(),
  'node.querystring.escape': (s) => querystring.escape(s),
  'node.b64': (s) => Buffer.from(s, 'utf8').toString('base64'),
  'node.b64url': (s) => Buffer.from(s, 'utf8').toString('base64url'),
  'node.hex': (s) => Buffer.from(s, 'utf8').toString('hex'),
  'node.jsyaml_dump_obj': (s) => yaml.dump({ k: s }),
};

for (const [p, fn] of Object.entries(printers)) {
  for (const [c, v] of Object.entries(cases)) {
    let out;
    try {
      out = fn(v);
    } catch (e) {
      out = 'ERROR ' + e.name;
    }
    console.log(JSON.stringify({ p, c, out }));
  }
}
