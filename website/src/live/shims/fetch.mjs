// Clause 1: the GitHub stand-in at the fetch seam. Answers the two GETs and the comment POST of
// examples/08-pr-review from fixture.json (same content as record.mjs's startGitHubMockServer);
// anything else throws, naming the method and URL. The page's own fetch is untouched.
import FIX from '__REALM_DEMO_FIXTURE__';
import { log } from './log.mjs';
const BASE = 'https://api.github.com';
const routes = Object.entries(FIX).map(([k, v]) => {
  const [m, p] = k.split(' ');
  return { m, re: new RegExp('^' + p.replace(/:[a-z]+/g, '[^/]+') + '$'), v };
});
async function standIn(input, opts = {}) {
  const url = String(input);
  const m = (opts.method ?? 'GET').toUpperCase();
  log.fetches.push(m + ' ' + url);
  const u = new URL(url);
  const r = u.origin === BASE ? routes.find((x) => x.m === m && x.re.test(u.pathname)) : undefined;
  if (!r) {
    log.unrouted.push(m + ' ' + url);
    throw new Error('demo stand-in: no route for ' + m + ' ' + url);
  }
  let data;
  if ('echo' in r.v) {
    const b = JSON.parse(opts.body);
    data = {};
    for (const f of r.v.echo) data[f] = b[f];
  } else data = r.v.body;
  const text = JSON.stringify(data);
  return {
    ok: r.v.status >= 200 && r.v.status < 300,
    status: r.v.status,
    statusText: r.v.status === 201 ? 'Created' : 'OK',
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}
export { standIn as fetch };
