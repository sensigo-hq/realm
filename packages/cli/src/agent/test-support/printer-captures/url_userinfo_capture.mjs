// url_userinfo_capture.mjs — the WHATWG URL userinfo (Node's `URL`): a FAKE password set on a URL, then
// printed through `href`, over the FAKE inputs named on the command line (a JSON object: id -> value).
/* global console, process, URL */
import { readFileSync } from 'node:fs';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [c, v] of Object.entries(cases)) {
  let out;
  try {
    const u = new URL('https://user@db.example/x');
    u.password = v;
    out = u.href;
  } catch (e) {
    out = 'ERROR ' + e.name;
  }
  console.log(JSON.stringify({ p: 'node.URL.password.href', c, out }));
}
