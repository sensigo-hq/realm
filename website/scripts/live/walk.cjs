// The live demo's browser walk (#624, design rev 4 AC 2–6 and the prompt's Live state table): the full
// flow on the BUILT home page, in real browsers, through the real stepper's DOM. Run it at every
// version bump (pre-publication checklist Part B, step 11) and at deploy.
//
// How to run (Playwright is NOT a website dependency; point at any playwright-core install whose
// browsers are installed):
//   npm run build                                                     # in website/
//   python3 -m http.server 8624 --bind 0.0.0.0 --directory dist &     # any static server
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM_PATH=/path/to/chrome] \
//     node scripts/live/walk.cjs <secure-url> [insecure-url]
// <secure-url> must be a secure context: https, or http://127.0.0.1:<port>/. [insecure-url] is the
// same server over plain http on a non-loopback address (http://<LAN address>:<port>/, see
// `hostname -I`); without it the insecure-context fallback prints SKIP.
// Runs Chromium and Firefox, each at 1280 and 375 px (WALK_ONLY=chromium:375 runs one of the four).
// Prints one PASS/FAIL line per check; exits 1 on
// any FAIL. Everything it does to the page is from the outside (clicks, typing, routing the bundle
// request); the shipped page has no test hooks.
const pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const [, , BASE, INSECURE] = process.argv;
if (!BASE) {
  console.log('usage: node scripts/live/walk.cjs <secure-url> [insecure-url]');
  process.exit(2);
}
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/data/replay.json'), 'utf8'));
const recordedRunIds = Object.values(R.endings).map((e) => e.run_id);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const recordedGateIds = [
  ...Object.values(R.endings).flatMap((e) => e.respond.stdout.match(UUID) ?? []),
  ...(R.attempts.find((a) => a.id === 'valid').response.context_hint.match(UUID) ?? []),
];
const recordedPrefixes = [...new Set([...recordedRunIds, ...recordedGateIds])].map((x) =>
  x.slice(0, 8),
);
const host = new URL(BASE).host;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BUNDLE = '**/live/realm-demo.*';
const NOTE = {
  noLoad: 'The live engine could not load, so this shows the recording.',
  insecure: 'Live mode needs a secure (HTTPS) page, so this shows the recording.',
  noStart: 'The live engine did not start a run (error TEST_REFUSED), so this shows the recording.',
  failedStart: 'The live engine failed to start, so this shows the recording.',
  timeout: 'The live engine took too long to load, so this shows the recording.',
};
const S = {
  beforeGate: 'The run reaches the gate once write_review is accepted.',
  stop: 'The step is complete and the run stops at the gate.',
  need4: 'Answer the gate first. This stage opens once the gate is answered.',
  need5: 'Answer the gate first. There is no finished record until the gate is answered.',
  skipLabel: 'Or let the agent try to skip the gate',
  shown:
    'This is what the reviewer was shown. The run is in phase gate_waiting and neither posting step is available to the agent.',
  agentSends: 'On this release the agent still sends the chosen step itself.',
  record:
    "One entry for each step that ran and for the gate answer, each with a hash. Refused calls leave no entry; counted refusals are noted on the step's entry.",
  notFinished: 'The run is not finished: the agent has not sent the chosen step yet.',
  readBack:
    'This run lives only in this page. With Realm installed, realm run inspect <run-id> reads a run back.',
  failed: 'This run failed after 6 counted refusals.',
  failedBeforeGate: 'This run failed before reaching the gate.',
  // correction 1: the stage 3 heading per state, the stage-4 labels, the stage 5 heading, the footer
  gateB: 'The run stops. The posting steps cannot run until the gate is answered.',
  gateA: 'The run has not reached the gate yet.',
  gateCD: 'The gate is answered.',
  otherTried: 'The agent tries the branch that was not chosen',
  skippedLabel: 'Skipped, with the reason on the record',
  recordTitle: 'What is left behind.',
  footerEnd: "Long text is shortened with “…”; Full reply shows Realm's reply whole.",
};
// Stage 3's heading and Next's label at stage 3, per state.
const GATE_HEAD = { A: S.gateA, B: S.gateB, C: S.gateCD, D: S.gateCD, E: S.failedBeforeGate };
const NEXT_AT_3 = {
  A: ['Waiting for the agent', true],
  B: ['Waiting for a human', true],
  C: ['Next', false],
  D: ['Next', false],
  E: ['Next', false],
};
// Where a label cell breaks a word: a line break between two word characters (a break after "_"
// or at a space is allowed). Runs in the page; returns the offending cells' text.
const wordBreaks = (sel) => {
  const out = [];
  for (const c of document.querySelectorAll(sel)) {
    if (!c.getClientRects().length) continue;
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let prevTop = null,
      prevCh = '';
    for (let n = w.nextNode(); n; n = w.nextNode())
      for (let k = 0; k < n.data.length; k++) {
        const rg = document.createRange();
        rg.setStart(n, k);
        rg.setEnd(n, k + 1);
        const r = rg.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (
          prevTop !== null &&
          r.top > prevTop + 2 &&
          /\w/.test(prevCh) &&
          prevCh !== '_' &&
          /\w/.test(n.data[k])
        )
          out.push(c.textContent);
        prevTop = r.top;
        prevCh = n.data[k];
      }
  }
  return out;
};
const fakeBundle = (startBody) =>
  `export const version = "test"; export async function start() { ${startBody} }`;

let failedTotal = 0;
async function walk(which, width) {
  const results = [];
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!cond) failed++;
  };
  const browser = await (which === 'chromium'
    ? pw.chromium.launch(
        process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
      )
    : pw.firefox.launch());
  const tag = `${which} ${browser.version()} ${width}px`;
  const newPage = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 812 } });
    const page = await ctx.newPage();
    const reqs = [];
    page.on('request', (r) =>
      reqs.push({ method: r.method(), url: r.url(), type: r.resourceType() }),
    );
    const dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.dismiss().catch(() => {});
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (opts.route) await page.route(BUNDLE, opts.route);
    return { ctx, page, reqs, dialogs, errors };
  };

  // ---- the main context: the full flow in both endings, then the failed run
  const { page, reqs, dialogs, errors } = await newPage();
  const go = (i) => page.click(`.rp [data-go="${i}"]`);
  const nVis = (sel) => page.locator(sel).filter({ visible: true }).count();
  const txt = async (i) => {
    await go(i);
    return page.innerText(`.rp-stage[data-s="${i}"]`);
  };
  const idle = () =>
    page.waitForFunction(() => !document.querySelector('[data-act="send"]').disabled);
  const sendOut = () => page.innerText('[data-box="send"]');
  async function sendBox(step, text, dbl = false) {
    await go(1);
    await page.selectOption('[data-l="step"]', step);
    await page.fill('[data-l="box"]', text);
    const t0 = Date.now();
    if (dbl) await page.dblclick('[data-act="send"]');
    else await page.click('[data-act="send"]');
    await idle();
    return { txt: await sendOut(), ms: Date.now() - t0 };
  }
  const preset = async (label) => {
    await go(1);
    await page.click(`.rp-stage[data-s="1"] [data-pick]:text-is("${label}")`);
  };
  // Headings as they would show if their stage were current (the stage's own `hidden` ignored).
  const headings = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.rp h3')]
        .filter((h) => {
          for (let e = h; e && !e.classList.contains('rp-stage'); e = e.parentElement)
            if (getComputedStyle(e).display === 'none') return false;
          return true;
        })
        .map((h) => h.textContent),
    );
  const letter = () => page.getAttribute('.rp', 'data-live-state');
  const warnings = new Set();
  const collectWarnings = () =>
    page
      .evaluate(() =>
        [...document.querySelectorAll('.rp [data-box] details pre, [data-l="start-full"]')].map(
          (p) => p.textContent,
        ),
      )
      .then((ts) => {
        for (const t of ts)
          try {
            for (const w of JSON.parse(t).warnings ?? []) if (/store/i.test(w)) warnings.add(w);
          } catch {}
      });
  const diag = () =>
    page.evaluate(async () =>
      (
        await import(new URL(document.querySelector('.rp').dataset.liveBundle, location.href).href)
      ).diagnostics(),
    );
  const marker = () => page.textContent('.rp-live-mark [data-say="marker"]');
  const focusIs = (sel) =>
    page.evaluate((s) => document.activeElement === document.querySelector(s), sel);

  async function common(stateName) {
    for (const i of [0, 1, 2, 3, 4]) {
      const t = await txt(i);
      const hits = recordedPrefixes.filter((p) => t.includes(p));
      ok(
        `${stateName} stage ${i + 1}: not blank, no recorded run-id or gate-id prefix, .rp-foot hidden`,
        t.replace(/\s+/g, '').length > 20 &&
          hits.length === 0 &&
          !(await page.isVisible('.rp > p.rp-foot')) &&
          (await page.isVisible('.rp-foot-live')),
        `hits=${JSON.stringify(hits)}`,
      );
    }
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(`${stateName}: no horizontal scroll`, sw <= 0, `overflow ${sw}px`);
  }
  // Every cell of the Live state table, for the state the run is in.
  // path (D only): 'stage4' when the chosen step was sent with stage 4's button, 'stage2' when it
  // was sent from stage 2's editor.
  async function cells(L, ending, path = 'stage4') {
    const name = `state ${L}${ending ? ' (' + ending.choice + (L === 'D' ? ', sent from ' + path : '') + ')' : ''}`;
    ok(`${name}: data-live-state`, (await letter()) === L, String(await letter()));
    // stage 2
    let t = await txt(1);
    ok(
      `${name} stage 2: editor, step selector, Send, five presets`,
      (await nVis('[data-l="box"]')) === 1 &&
        (await nVis('[data-l="step"]')) === 1 &&
        (await nVis('[data-act="send"]')) === 1 &&
        (await nVis('.rp-stage[data-s="1"] [data-pick]')) === 5,
    );
    ok(
      `${name} stage 2: the failed line and Start a new run only in E`,
      (L === 'E') === t.includes(S.failed) &&
        (await nVis('.rp-stage[data-s="1"] [data-act="new"]')) === (L === 'E' ? 1 : 0),
    );
    const stopEl = '.rp-stage[data-s="1"] [data-say="stop"]';
    ok(
      `${name} stage 2: the :63 stop sentence (exact) only in B`,
      L === 'B'
        ? (await page.isVisible(stopEl)) && (await page.textContent(stopEl)) === S.stop
        : !(await page.isVisible(stopEl)),
      JSON.stringify(await page.textContent(stopEl)),
    );
    // stage 3
    t = await txt(2);
    const answers = await nVis('[data-act="answer"]'),
      skips = await nVis('[data-act="skip"]');
    const next = [await page.textContent('[data-next]'), await page.isDisabled('[data-next]')];
    const heads3 = await page
      .locator('.rp-stage[data-s="2"] h3')
      .filter({ visible: true })
      .allTextContents();
    ok(
      `${name} stage 3: the heading for ${L} and Next "${NEXT_AT_3[L][0]}"${NEXT_AT_3[L][1] ? ' (disabled)' : ''}`,
      JSON.stringify(heads3) === JSON.stringify([GATE_HEAD[L]]) &&
        JSON.stringify(next) === JSON.stringify(NEXT_AT_3[L]),
      JSON.stringify({ heads3, next }),
    );
    if (L === 'A')
      ok(
        `${name} stage 3: the before-gate sentence, no buttons, Next waits`,
        t.includes(S.beforeGate) &&
          answers + skips === 0 &&
          !(await page.isVisible('[data-l="gate"]')) &&
          next[0] === 'Waiting for the agent' &&
          next[1],
        JSON.stringify(next),
      );
    if (L === 'B') {
      ok(
        `${name} stage 3: gate text = the recording, Approve/Request changes, two skip attempts, :73, Next waits`,
        (await page.textContent('[data-l="gate"]')) === R.gate.display &&
          answers === 2 &&
          skips === 2 &&
          t.toLowerCase().includes(S.skipLabel.toLowerCase()) &&
          t.includes(S.shown) &&
          !t.includes(S.beforeGate) &&
          next[0] === 'Waiting for a human' &&
          next[1],
        JSON.stringify(next),
      );
      ok(
        `${name} stage 3: no "answer the gate itself" attempt`,
        !/answer the gate itself|answers the gate/i.test(t),
      );
    }
    if (L === 'C' || L === 'D')
      ok(
        `${name} stage 3: gate text, "The reviewer chose X.", NO reviewer's box (it is on stage 4), NO answer buttons, NO skip attempts, Next enabled`,
        (await page.textContent('[data-l="gate"]')) === R.gate.display &&
          t.includes(`The reviewer chose ${ending.choice}.`) &&
          !/THE REVIEWER ANSWERS/i.test(t) &&
          (await page.locator('.rp-stage[data-s="2"] [data-box="answer"]').count()) === 0 &&
          answers === 0 &&
          skips === 0 &&
          !t.includes(S.shown) &&
          next[0] === 'Next' &&
          !next[1],
        JSON.stringify(next),
      );
    if (L === 'E')
      ok(
        `${name} stage 3: "This run failed before reaching the gate." once (the heading) + Start a new run, no buttons`,
        t.split(S.failedBeforeGate).length === 2 &&
          (await nVis('.rp-stage[data-s="2"] [data-act="new"]')) === 1 &&
          answers + skips === 0 &&
          !(await page.isVisible('[data-l="gate"]')) &&
          !t.includes(S.beforeGate),
      );
    // stage 4
    t = await txt(3);
    const posts = await nVis('[data-act="post"]'),
      others = await nVis('[data-act="other"]');
    if (L === 'A' || L === 'B')
      ok(
        `${name} stage 4: only the "Answer the gate first" hint`,
        t.trim() === S.need4 && posts + others === 0,
        JSON.stringify(t.trim().slice(0, 120)),
      );
    if (L === 'C')
      ok(
        `${name} stage 4: the :104 heading and sentence, the next step, the other branch`,
        t.startsWith(`The reviewer chose ${ending.choice}. Realm closes the other branch.\n`) &&
          t.includes(S.agentSends) &&
          posts === 1 &&
          others === 1 &&
          !t.includes(S.need4),
        JSON.stringify(t.slice(0, 160)),
      );
    if (L === 'D')
      ok(
        `${name} stage 4: no send button, no other-branch button, no agent-sends sentence`,
        t.startsWith(`The reviewer chose ${ending.choice}. Realm closes the other branch.\n`) &&
          !t.includes(S.agentSends) &&
          posts + others === 0,
        JSON.stringify(t.slice(0, 160)),
      );
    if (L === 'C' || L === 'D') {
      const s4 = '.rp-stage[data-s="3"] ';
      const ansT = (await page.isVisible(s4 + '[data-box="answer"]'))
        ? await page.innerText(s4 + '[data-box="answer"]')
        : '';
      ok(
        `${name} stage 4: the reviewer's box (its call and reply), labelled by its actor`,
        /^THE REVIEWER ANSWERS\n/i.test(ansT) &&
          ansT.includes('submit_human_response') &&
          /REALM ACCEPTS IT/i.test(ansT),
        JSON.stringify(ansT.slice(0, 120)),
      );
      const otherT = await page.innerText(s4 + '[data-box="other"]');
      ok(
        `${name} stage 4: a tried other branch is labelled "${S.otherTried}", never "Agent calls"`,
        otherT === '' ||
          (otherT.toLowerCase().startsWith(S.otherTried.toLowerCase() + '\n') &&
            !/AGENT CALLS/i.test(otherT)),
        JSON.stringify(otherT.slice(0, 80)),
      );
      // the other-branch button in the left column, the send button in the right (C only)
      const col = (sel) =>
        page.evaluate(
          ([s4, sel]) => {
            const b = document.querySelector(s4 + sel);
            const cols = [...document.querySelectorAll(s4 + '.rp-end-live .rp-cols > div')];
            return cols.findIndex((c) => c.contains(b));
          },
          [s4, sel],
        );
      if (L === 'C')
        ok(
          `${name} stage 4: the other-branch button in the left column, the send button in the right`,
          (await col('[data-act="other"]')) === 0 && (await col('[data-act="post"]')) === 1,
        );
      const skipT = await page
        .locator(s4 + '[data-l="skip"]')
        .filter({ visible: true })
        .allTextContents();
      ok(
        `${name} stage 4: "${S.skippedLabel}" + the skip line = the recording`,
        (await page.textContent(s4 + '[data-say="skippedLabel"]')) === S.skippedLabel &&
          (await page.isVisible(s4 + '[data-say="skippedLabel"]')) &&
          JSON.stringify(skipT) === JSON.stringify([ending.skipped]),
        JSON.stringify(skipT),
      );
      const ranVis = await page.isVisible(s4 + '[data-say="ran"]');
      if (L === 'C') ok(`${name} stage 4: no "Ran:" before the step is sent`, !ranVis);
      if (L === 'D') {
        const ranT = ranVis ? await page.innerText(s4 + '[data-say="ran"]') : '';
        ok(
          `${name} stage 4: "Ran: ${ending.posted.step}"`,
          ranT.toLowerCase() === `ran: ${ending.posted.step}`,
          JSON.stringify(ranT),
        );
        const postVis = await page.isVisible(s4 + '[data-box="post"]');
        const postT = postVis ? await page.innerText(s4 + '[data-box="post"]') : '';
        const s2Vis = await page.isVisible(s4 + '[data-l="sent2"]');
        const s2T = s2Vis ? await page.innerText(s4 + '[data-l="sent2"]') : '';
        const posted = ending.evidence.at(-1);
        if (path === 'stage4')
          ok(
            `${name} stage 4: "Ran:" shows the accepted reply and Full reply, without the call`,
            /^REALM ACCEPTS IT\n/i.test(postT) &&
              !/AGENT CALLS/i.test(postT) &&
              (await page.locator(s4 + '[data-box="post"] > pre').count()) === 1 &&
              (await page.locator(s4 + '[data-box="post"] details').count()) === 1 &&
              !s2Vis,
            JSON.stringify(postT.slice(0, 120)),
          );
        else
          ok(
            `${name} stage 4: "Ran:" shows "The agent sent ${ending.posted.step} from stage 2." and its row from the record`,
            !postVis &&
              s2T.startsWith(`The agent sent ${ending.posted.step} from stage 2.\n`) &&
              s2T
                .replace(/\s+/g, ' ')
                .includes(`${ending.posted.step} success ${posted.hash.slice(0, 12)}…`) &&
              (await page.getAttribute(s4 + '[data-l="sent2-row"] code[title]', 'title')) ===
                posted.hash,
            JSON.stringify(s2T.slice(0, 160)),
          );
        ok(
          `${name} stage 4: not empty below the heading (the reviewer's box, "Ran:", the skip line)`,
          t.replace(/\s+/g, ' ').length >
            `The reviewer chose ${ending.choice}. Realm closes the other branch.`.length + 40 &&
            t.includes(ending.skipped),
          JSON.stringify(t.slice(0, 200)),
        );
        if (width < 600 && otherT) {
          const tops = await page.evaluate(
            (s4) =>
              ['[data-box="answer"]', '[data-box="other"]', '[data-say="ran"]'].map(
                (x) => document.querySelector(s4 + x).getBoundingClientRect().top,
              ),
            s4,
          );
          ok(
            `${name} 375 px stage 4: top to bottom the reviewer's answer, the other-branch attempt, then "Ran:"`,
            tops[0] < tops[1] && tops[1] < tops[2],
            JSON.stringify(tops.map(Math.round)),
          );
        }
      }
    }
    if (L === 'E')
      ok(
        `${name} stage 4: "This run failed before reaching the gate."`,
        t.trim() === S.failedBeforeGate,
        JSON.stringify(t.trim().slice(0, 120)),
      );
    // stage 5
    t = await txt(4);
    const rows = await page.$$eval('[data-l="table"] [role="row"]', (rs) =>
      rs
        .filter((r) => r.getClientRects().length)
        .map((r) => r.innerText.split(/\s*\n\s*/).join(' | ')),
    );
    if (L === 'A' || L === 'B')
      ok(
        `${name} stage 5: only the "Answer the gate first" hint`,
        t.trim() === S.need5 && rows.length === 0,
        JSON.stringify(t.trim().slice(0, 120)),
      );
    if (L === 'C' || L === 'D') {
      const hashes = await page.$$eval(
        '[data-l="table"] [role="row"]:not(.skip) code[title]',
        (cs) => cs.map((c) => c.getAttribute('title')),
      );
      const want = ending.evidence.map((x) => x.hash);
      ok(
        `${name} stage 5: ${L === 'C' ? 'the record so far + the not-finished line' : 'the full record'}`,
        t.includes('What is left behind.') &&
          t.includes(S.record) &&
          t.includes(S.readBack) &&
          (L === 'C') === t.includes(S.notFinished) &&
          JSON.stringify(hashes) === JSON.stringify(L === 'C' ? want.slice(0, 4) : want),
        JSON.stringify(rows),
      );
    }
    if (L === 'E')
      ok(
        `${name} stage 5: "What is left behind." (heading only), the record so far + "This run failed after 6 counted refusals."`,
        t.includes(S.failed) &&
          t.startsWith(S.recordTitle + '\n') &&
          !t.includes(S.record) &&
          rows[0]?.startsWith('fetch_pr | success') &&
          rows[1]?.startsWith('write_review | error') &&
          !t.includes(S.need5),
        JSON.stringify(rows),
      );
    if (L === 'C' || L === 'D' || L === 'E') {
      // the stage-5 table's step names wrap only after an underscore, never inside a word
      const bad = await page.evaluate(() => {
        const out = [];
        for (const c of document.querySelectorAll(
          '[data-l="table"] [role="cell"]:first-child code',
        )) {
          const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
          let prevTop = null,
            prevCh = '';
          for (let n = w.nextNode(); n; n = w.nextNode())
            for (let k = 0; k < n.data.length; k++) {
              const rg = document.createRange();
              rg.setStart(n, k);
              rg.setEnd(n, k + 1);
              const top = rg.getBoundingClientRect().top;
              if (prevTop !== null && top > prevTop + 2 && prevCh !== '_') out.push(c.textContent);
              prevTop = top;
              prevCh = n.data[k];
            }
        }
        return out;
      });
      ok(`${name} stage 5: step names break only after "_"`, bad.length === 0, JSON.stringify(bad));
      const lb = await page.evaluate(
        `(${wordBreaks})('[data-l="table"] [role="cell"]:nth-child(2)')`,
      );
      ok(
        `${name} stage 5: labels (e.g. "human chose request_changes") never break inside a word`,
        lb.length === 0,
        JSON.stringify(lb),
      );
    }
    await collectWarnings();
  }

  await page.goto(BASE);
  await go(1);
  await page.waitForSelector('[data-live-try]:not([hidden])');
  ok(
    'AC 4: no bundle request before the click',
    !reqs.some((r) => r.url.includes('/live/realm-demo')),
  );
  const chunk = reqs.find((r) => /Replay\.astro.*\.js$/.test(r.url));
  if (chunk) {
    const gz = zlib.gzipSync(await (await page.request.get(chunk.url)).body(), { level: 9 }).length;
    ok('AC 4: the always-loaded live-layer chunk is under 4 KB gzip', gz < 4096, `${gz} B gzip`);
  } else
    ok('AC 4: the always-loaded live-layer chunk is found', false, 'no Replay chunk requested');
  ok(
    'recorded mode: the recorded footer, no live marker, no note',
    (await page.isVisible('.rp > p.rp-foot')) &&
      !(await page.isVisible('.rp-live-mark')) &&
      !(await page.isVisible('[data-live-note]')),
  );
  ok(
    'recorded mode: Try reads "Try it yourself — the real engine, in your browser"',
    (await page.textContent('[data-live-try]')) ===
      'Try it yourself — the real engine, in your browser',
  );
  const beforeTry = reqs.length;
  let t0 = Date.now();
  await page.click('[data-live-try]');
  await page.waitForSelector('.rp[data-mode="live"]', { timeout: 30000 });
  await idle();
  results.push(`INFO  click→live ${Date.now() - t0} ms`);
  let m = await marker();
  ok(
    'live marker',
    /^Live · Realm \d+\.\d+\.\d+ in your browser · run [0-9a-f]{8}$/.test(m) &&
      m.includes(R.meta.realm_version),
    m,
  );
  ok('no fallback note in live mode', !(await page.isVisible('[data-live-note]')));
  ok('Try lands on stage 2', (await page.getAttribute('.rp', 'data-stage')) === '1');
  ok('focus: after Try, the stage-2 heading', await focusIs('.rp-stage[data-s="1"] h3'));
  let runId = m.slice(-8);
  ok('run id is not a recorded run id', !recordedRunIds.some((x) => x.startsWith(runId)), runId);
  ok(
    'live footer',
    (await page.textContent('.rp-foot-live [data-say="footer"]')) ===
      `Live · Realm ${R.meta.realm_version} running in your browser · run ${runId}. GitHub is a stand-in inside this page; nothing is posted. Runs are kept in memory and disappear when you leave. ${S.footerEnd}`,
  );
  const fs1 = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.rp-foot-live p')).fontSize,
    getComputedStyle(document.querySelector('.rp > p.rp-foot')).fontSize,
  ]);
  ok('the live footer uses the recorded footer size', fs1[0] === fs1[1], JSON.stringify(fs1));
  await go(0);
  ok(
    'stage 1: the live start reply, the fetched PR, the live fetch_pr hash = recorded',
    (await page.getAttribute('[data-l="pr-hash"]', 'title')) === R.start.evidence.hash &&
      (await page.textContent('[data-l="pr-head"]')).includes(R.start.pr.pr_title) &&
      (await page.textContent('[data-l="start-reply"]')).includes('"status": "ok"'),
  );
  await cells('A');
  await common('state A');

  // ---- refusals in state A
  const h0 = await headings();
  const times = [];
  let r = await sendBox('post_approval', '{}');
  times.push(r.ms);
  ok(
    'skip-ahead → Realm refuses + "Nothing was counted."',
    /REALM REFUSES/i.test(r.txt) && r.txt.includes('Nothing was counted.'),
    r.txt.split('\n').slice(0, 6).join(' | '),
  );
  await preset('Leave out a field');
  ok(
    'a preset fills the editor and shows "Press Send to submit it."',
    (await page.inputValue('[data-l="step"]')) === 'write_review' &&
      (await page.inputValue('[data-l="box"]')) ===
        JSON.stringify(R.attempts.find((a) => a.id === 'missing_field').call.params, null, 2) &&
      (await page.isVisible('[data-l="hint"]')) &&
      (await page.textContent('[data-l="hint"]')) === 'Press Send to submit it.',
  );
  await page.click('[data-act="send"]');
  await idle();
  r = { txt: await sendOut() };
  ok(
    'schema refusal → Realm refuses, "This refusal is counted (1 of 6)."',
    /REALM REFUSES/i.test(r.txt) && r.txt.includes('This refusal is counted (1 of 6).'),
    r.txt.split('\n').slice(0, 6).join(' | '),
  );
  if (width < 600) {
    const vis = await page.evaluate(() => {
      const l = document.querySelectorAll('[data-box="send"] > .rp-k')[1];
      const b = l.getBoundingClientRect();
      return [b.top, b.bottom, innerHeight];
    });
    // a sub-pixel overhang (rounding) is still in view; the verdict's whole line must be
    ok(
      '375 px: after Send the verdict is in view',
      vis[0] >= 0 && vis[1] <= vis[2] + 0.5 && vis[1] - vis[0] > 10,
      JSON.stringify(vis.map((x) => Math.round(x * 10) / 10)),
    );
  }
  r = await sendBox('write_review', await page.inputValue('[data-l="box"]'), true);
  ok(
    'a double-click on Send sends one call (2 of 6, not 3)',
    r.txt.includes('This refusal is counted (2 of 6).'),
    r.txt.split('\n').slice(0, 6).join(' | '),
  );
  for (const [label, text, want] of [
    ['broken JSON', '{bad', 'This is not valid JSON'],
    ['empty input', '', 'This is not valid JSON'],
    ['trailing comma', '{"risk":"high",}', 'This is not valid JSON'],
    ['17 KB', JSON.stringify({ x: 'y'.repeat(17000) }), 'The page sends at most 16 KB'],
    ['depth 40', '['.repeat(40) + '1' + ']'.repeat(40), 'The page sends at most 32 levels'],
  ]) {
    r = await sendBox('write_review', text);
    ok(
      `${label} → "The page could not send this" (the page's own check), nothing sent`,
      /THE PAGE COULD NOT SEND THIS/i.test(r.txt) &&
        r.txt.includes('(The page’s own check.)') &&
        r.txt.includes(want) &&
        !/AGENT CALLS/i.test(r.txt),
      r.txt.split('\n').slice(0, 3).join(' | '),
    );
  }
  r = await sendBox('write_review', '[]');
  times.push(r.ms);
  ok(
    'params [] → Realm\'s MCP layer refuses, its message once, "Nothing was counted."',
    /REALM’S MCP LAYER REFUSES/i.test(r.txt) &&
      r.txt.split('MCP error').length === 2 &&
      r.txt.includes('Nothing was counted.'),
    r.txt.split('\n').slice(0, 8).join(' | '),
  );
  r = await sendBox('write_review', '{“risk”: “high”}');
  ok(
    'curly quotes → straightened with a note, Realm refuses (3 of 6)',
    r.txt.includes('The page replaced curly quotes with straight ones before sending.') &&
      r.txt.includes('This refusal is counted (3 of 6).'),
    r.txt.split('\n').slice(-3).join(' | '),
  );
  r = await sendBox('confirm_review', '{}');
  ok(
    'the gate step sent by the agent → Realm refuses, not counted',
    /REALM REFUSES/i.test(r.txt) && r.txt.includes('Nothing was counted.'),
  );
  ok(
    'refused calls change no heading and leave state A',
    JSON.stringify(await headings()) === JSON.stringify(h0) && (await letter()) === 'A',
  );

  // ---- the valid review → state B
  await preset('Submit a valid review');
  await page.click('[data-act="send"]');
  await idle();
  r = { txt: await sendOut() };
  ok(
    'valid → Realm accepts it + the :63 stop sentence',
    /REALM ACCEPTS IT/i.test(r.txt) &&
      (await page.textContent('.rp-stage[data-s="1"] [data-say="stop"]')) === S.stop,
    r.txt.split('\n').slice(-4).join(' | '),
  );
  const shown = await page.textContent('[data-box="send"] > pre:not(:first-of-type)');
  await page.click('[data-box="send"] summary');
  const full = await page.innerText('[data-box="send"] details pre');
  const hint = JSON.parse(full).context_hint;
  ok(
    'a long reply string is shortened with "…" and shown whole under "Full reply"',
    hint.length > 64 && shown.includes(hint.slice(0, 61) + '…') && full.includes(hint),
    hint.slice(0, 80),
  );
  await cells('B');
  const h1 = await headings();
  await go(2);
  const gateOut = [];
  for (const b of await page.$$('[data-act="skip"]')) {
    await b.click();
    await idle();
    gateOut.push(await page.innerText('[data-box="skip"]'));
  }
  ok(
    'stage 3: exactly two agent attempts, both refused, not counted',
    gateOut.length === 2 &&
      gateOut.every((x) => /REALM REFUSES/i.test(x) && x.includes('Nothing was counted.')),
    gateOut.map((x) => x.split('\n').slice(-1)[0]).join(' | '),
  );
  ok(
    'refused skip attempts change no heading and leave state B',
    JSON.stringify(await headings()) === JSON.stringify(h1) && (await letter()) === 'B',
  );
  // ---- the answer → state C
  const ending1 = R.endings.request_changes;
  await page.click('[data-act="answer"][data-choice="request_changes"]');
  await page.waitForFunction(() => document.querySelector('.rp').dataset.liveGate === 'answered');
  await idle();
  ok(
    'the answer lands on stage 4, focus on its heading',
    (await page.getAttribute('.rp', 'data-stage')) === '3' &&
      (await focusIs('.rp-stage[data-s="3"] h3[data-say="branch"]')),
  );
  await cells('C', ending1);
  const h2 = await headings();
  await go(3);
  await page.click('[data-act="other"]');
  await idle();
  ok(
    'the other branch → Realm refuses; state C, no heading changed',
    /REALM REFUSES/i.test(await page.innerText('[data-box="other"]')) &&
      (await letter()) === 'C' &&
      JSON.stringify(await headings()) === JSON.stringify(h2),
  );
  const posts = async () => (await diag()).fetches.filter((f) => f.startsWith('POST')).length;
  const p0 = await posts();
  await go(3);
  await page.dblclick('[data-act="post"]');
  await page.waitForFunction(() => document.querySelector('.rp').dataset.liveState === 'D');
  await idle();
  ok(
    'a double-click on "The agent sends the next step" sends one call',
    (await posts()) - p0 === 1,
  );
  await cells('D', ending1);
  ok(
    'state D: the other-branch reply stays shown',
    /REALM REFUSES/i.test(await page.innerText('[data-box="other"]')),
  );
  await common('state D (request_changes)');
  r = await sendBox('post_changes_request', '{}');
  ok(
    'a call on the finished run → "The run has already ended"',
    /THE RUN HAS ALREADY ENDED/i.test(r.txt),
  );
  ok('every call under 1 s after load', Math.max(...times) < 1000, JSON.stringify(times));

  // ---- the second ending (approve)
  await page.click('.rp-live-mark [data-act="new"]');
  await page.waitForFunction(
    (id) => !document.querySelector('.rp-live-mark p').textContent.endsWith(id),
    runId,
  );
  await idle();
  m = await marker();
  ok(
    'Start a new run: a new run id, stage 2, focus on its heading, empty answer column',
    m.slice(-8) !== runId &&
      (await page.getAttribute('.rp', 'data-stage')) === '1' &&
      (await focusIs('.rp-stage[data-s="1"] h3')) &&
      (await sendOut()) === '',
  );
  runId = m.slice(-8);
  await cells('A');
  await preset('Submit a valid review');
  await page.click('[data-act="send"]');
  await idle();
  await cells('B');
  await go(2);
  await page.click('[data-act="answer"][data-choice="approve"]');
  await page.waitForFunction(() => document.querySelector('.rp').dataset.liveGate === 'answered');
  await idle();
  ok(
    'approve → focus on the stage-4 heading',
    await focusIs('.rp-stage[data-s="3"] h3[data-say="branch"]'),
  );
  await cells('C', R.endings.approve);
  await go(3);
  await page.click('[data-act="post"]');
  await page.waitForFunction(() => document.querySelector('.rp').dataset.liveState === 'D');
  await idle();
  ok(
    'a single click on "The agent sends the next step" → stage 4, focus on its heading',
    (await page.getAttribute('.rp', 'data-stage')) === '3' &&
      (await focusIs('.rp-stage[data-s="3"] h3[data-say="branch"]')),
  );
  await cells('D', R.endings.approve);
  await common('state D (approve)');

  // ---- the chosen step sent from stage 2's editor (both endings): stage 4 is not empty in D
  for (const ending of [R.endings.request_changes, R.endings.approve]) {
    await page.click('.rp-live-mark [data-act="new"]');
    await page.waitForFunction(
      (id) => !document.querySelector('.rp-live-mark p').textContent.endsWith(id),
      runId,
    );
    await idle();
    runId = (await marker()).slice(-8);
    await preset('Submit a valid review');
    await page.click('[data-act="send"]');
    await idle();
    await go(2);
    await page.click(`[data-act="answer"][data-choice="${ending.choice}"]`);
    await page.waitForFunction(() => document.querySelector('.rp').dataset.liveGate === 'answered');
    await idle();
    r = await sendBox(ending.posted.step, '{}');
    ok(
      `stage 2 path (${ending.choice}): the chosen step sent from the editor → Realm accepts it, state D`,
      /REALM ACCEPTS IT/i.test(r.txt) && (await letter()) === 'D',
      r.txt.split('\n').slice(0, 4).join(' | '),
    );
    await cells('D', ending, 'stage2');
  }

  // ---- the failed run (state E): six counted refusals
  await page.click('.rp-live-mark [data-act="new"]');
  await page.waitForFunction(
    (id) => !document.querySelector('.rp-live-mark p').textContent.endsWith(id),
    runId,
  );
  await idle();
  runId = (await marker()).slice(-8);
  await preset('Leave out a field');
  const mf = await page.inputValue('[data-l="box"]');
  for (let i = 1; i <= 6; i++) r = await sendBox('write_review', mf);
  ok(
    'the 6th schema refusal: "(6 of 6)"',
    r.txt.includes('This refusal is counted (6 of 6).'),
    r.txt.split('\n').slice(0, 6).join(' | '),
  );
  await cells('E');
  await common('state E');
  r = await sendBox('write_review', mf);
  ok(
    'a call on the failed run → "The run has already ended"',
    /THE RUN HAS ALREADY ENDED/i.test(r.txt),
  );
  await go(2);
  await page.click('.rp-stage[data-s="2"] [data-act="new"]');
  await page.waitForFunction(
    (id) => !document.querySelector('.rp-live-mark p').textContent.endsWith(id),
    runId,
  );
  await idle();
  ok('Start a new run from stage 3 (state E) → a new run, state A', (await letter()) === 'A');

  // ---- markup in a submission renders as text
  const valid = JSON.parse(JSON.stringify(R.attempts.find((a) => a.id === 'valid').call.params));
  valid.key_changes[0] = '<img src=x onerror=alert(1)>';
  valid.review_comment = '<script>alert(2)</script> ' + valid.review_comment;
  await sendBox('write_review', JSON.stringify(valid));
  const gateText = await page.textContent('[data-l="gate"]');
  const made = await page.evaluate(
    () => document.querySelectorAll('.rp img, .rp-stage script').length,
  );
  ok(
    'AC 6: a markup submission renders as text',
    gateText.includes('<img src=x onerror=alert(1)>') &&
      gateText.includes('<script>alert(2)</script>') &&
      made === 0 &&
      dialogs.length === 0,
    `elements=${made} dialogs=${dialogs.length}`,
  );
  const d = await diag();
  ok(
    'in the browser: 0 calls into throwing members, 0 stand-in refusals',
    d.stubCalls.length === 0 && d.unrouted.length === 0,
    JSON.stringify({ stubCalls: d.stubCalls, unrouted: d.unrouted }),
  );
  ok(
    'no reply carries a warning mentioning a store',
    warnings.size === 0,
    [...warnings].join(' | '),
  );
  // AC 3
  const net = reqs.filter((x) => ['fetch', 'xhr', 'websocket', 'eventsource'].includes(x.type));
  ok(
    'AC 3a: zero fetch/xhr/websocket/eventsource requests',
    net.length === 0,
    net.map((x) => `${x.method} ${x.url} ${x.type}`).join(' '),
  );
  const scriptsAfter = reqs.slice(beforeTry).filter((x) => x.type === 'script');
  ok(
    'AC 3b: after Try the only script requested is /live/realm-demo.<sha8>.js',
    scriptsAfter.length > 0 &&
      scriptsAfter.every((x) =>
        /\/live\/realm-demo\.[0-9a-f]{8}\.js$/.test(new URL(x.url).pathname),
      ),
    scriptsAfter.map((x) => `${x.method} ${x.url} ${x.type}`).join(' '),
  );
  const off = reqs.filter((x) => {
    const h = new URL(x.url).host;
    return h !== host && !FONT_HOSTS.includes(h);
  });
  ok(
    'AC 3c: no api.github.com, no host but the page and the font hosts',
    off.length === 0 && !reqs.some((x) => new URL(x.url).hostname === 'api.github.com'),
    off.map((x) => `${x.method} ${x.url} ${x.type}`).join(' '),
  );
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await page.context().close();

  // ---- loading: the bundle held 3 s, then 25 s
  {
    const { page: p } = await newPage({
      route: async (route) => {
        await new Promise((res) => setTimeout(res, 3000));
        await route.continue();
      },
    });
    await p.goto(BASE);
    await p.click('.rp [data-go="1"]');
    await p.click('[data-live-try]');
    await p.waitForTimeout(800);
    ok(
      'loading (bundle delayed 3 s): Try reads "Loading the engine…", aria-busy="true", disabled',
      (await p.textContent('[data-live-try]')) === 'Loading the engine…' &&
        (await p.getAttribute('[data-live-try]', 'aria-busy')) === 'true' &&
        (await p.isDisabled('[data-live-try]')),
    );
    const look = await p.evaluate(() => {
      const c = getComputedStyle(document.querySelector('[data-live-try]'));
      return [c.opacity, c.cursor];
    });
    ok(
      'loading: Try has the disabled look (opacity 0.45, cursor not-allowed)',
      JSON.stringify(look) === JSON.stringify(['0.45', 'not-allowed']),
      JSON.stringify(look),
    );
    await p.waitForSelector('.rp[data-mode="live"]', { timeout: 30000 });
    ok(
      'loading (bundle delayed 3 s): then live',
      (await p.getAttribute('.rp', 'data-mode')) === 'live',
    );
    await p.context().close();
  }
  {
    const { page: p } = await newPage({
      route: async (route) => {
        await new Promise((res) => setTimeout(res, 25000));
        await route.continue().catch(() => {});
      },
    });
    await p.goto(BASE);
    await p.click('.rp [data-go="1"]');
    t0 = Date.now();
    await p.click('[data-live-try]');
    await p.waitForSelector('[data-live-note]:not([hidden])', { timeout: 30000 });
    const after = Date.now() - t0;
    const n = await p.textContent('[data-live-note]');
    await p.waitForTimeout(Math.max(0, 27000 - (Date.now() - t0)));
    ok(
      'time-out (bundle held 25 s): the note after 20 s, the recording stays after the bundle arrives',
      n === NOTE.timeout &&
        after >= 19500 &&
        (await p.getAttribute('.rp', 'data-mode')) === 'recorded' &&
        !(await p.isVisible('.rp-live-mark')) &&
        !(await p.isVisible('[data-live-try]')) &&
        (await p.isVisible('.rp > p.rp-foot')),
      `note after ${after} ms: "${n}"`,
    );
    await p.context().close();
  }

  // ---- recorded mode: the stage-5 labels wrap like the step names (both endings)
  for (const ending of Object.values(R.endings)) {
    const { page: p } = await newPage();
    await p.goto(BASE);
    await p.click('.rp [data-go="2"]');
    await p.click(`[data-choose="${ending.choice}"]`);
    await p.click('.rp [data-go="4"]');
    const lb = await p.evaluate(`(${wordBreaks})('.rp-end[data-rec] [role="cell"]:nth-child(2)')`);
    const n = await p.evaluate(
      () =>
        [...document.querySelectorAll('.rp-end[data-rec] [role="cell"]:nth-child(2)')].filter(
          (c) => c.getClientRects().length,
        ).length,
    );
    ok(
      `recorded ${ending.choice} stage 5: labels never break inside a word`,
      n > 0 && lb.length === 0,
      `cells=${n} ${JSON.stringify(lb)}`,
    );
    await p.context().close();
  }

  // ---- AC 5: the four fallbacks keep the recording with a note and no live marker
  const fallback = async (name, want, opts, url = BASE, click = true) => {
    const { page: p } = await newPage(opts);
    await p.goto(url);
    await p.click('.rp [data-go="1"]');
    if (click) {
      await p.waitForSelector('[data-live-try]:not([hidden])');
      await p.click('[data-live-try]');
    }
    await p.waitForSelector('[data-live-note]:not([hidden])', { timeout: 30000 });
    const n = await p.textContent('[data-live-note]');
    ok(
      `AC 5 fallback: ${name} → the recording + its note, no live marker, no Try`,
      n === want &&
        (await p.getAttribute('.rp', 'data-mode')) === 'recorded' &&
        !(await p.isVisible('.rp-live-mark')) &&
        !(await p.isVisible('[data-live-try]')) &&
        (await p.isVisible('.rp > p.rp-foot')) &&
        (await p.isVisible('.rp-stage[data-s="1"] [data-out="none"]')),
      `"${n}"`,
    );
    await p.context().close();
  };
  await fallback('bundle blocked', NOTE.noLoad, { route: (x) => x.abort() });
  if (INSECURE) await fallback('insecure context', NOTE.insecure, {}, INSECURE, false);
  else results.push('SKIP  AC 5 fallback: insecure context (no insecure-url given)');
  await fallback('start_run not ok', NOTE.noStart, {
    route: (x) =>
      x.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: fakeBundle(
          'return { workflowId: "pr-review", steps: [], call: async () => ({ kind: "json", value: { status: "error", error_code: "TEST_REFUSED" } }), run: async () => ({ evidence: [] }), close: async () => {} };',
        ),
      }),
  });
  await fallback('throw at start', NOTE.failedStart, {
    route: (x) =>
      x.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: fakeBundle('throw new Error("forced");'),
      }),
  });
  await browser.close();
  console.log(`=== ${tag}`);
  for (const x of results) console.log(x);
  console.log(
    failed
      ? `WALK FAILED (${tag}): ${failed} FAIL`
      : `WALK PASSED (${tag}): 0 FAIL, ${results.filter((x) => x.startsWith('PASS')).length} PASS`,
  );
  failedTotal += failed;
}

(async () => {
  for (const which of ['chromium', 'firefox'])
    for (const width of [1280, 375])
      if (!process.env.WALK_ONLY || process.env.WALK_ONLY === `${which}:${width}`)
        await walk(which, width);
  console.log(failedTotal ? `WALK FAILED: ${failedTotal} FAIL in total` : 'WALK PASSED: 0 FAIL');
  process.exit(failedTotal ? 1 : 0);
})().catch((e) => {
  console.log('CRASH', e.stack);
  process.exit(2);
});
