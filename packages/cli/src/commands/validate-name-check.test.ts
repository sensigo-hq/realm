// Fix 1, piece 4 — a handler or adapter a step needs that the project does not provide, on the
// commands. `validate`, `register` and `watch` warn (the codes' policy is 'warn'), print each warning
// once, and still accept the workflow; `--strict` fails on it; `validate --registered` warns with no
// line. In-process via commander's parseAsync. A project is a temp folder holding `realm.yaml`, whose
// `handlers:` / `adapters:` entries load a `use:` module in the same folder. The loader-level cells
// are core's name-check.test.ts; the runs (check 6) are name-check-runs.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowDefinition, WorkflowRegistrar } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { watchWorkflow } from './watch.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The `use:` module every project here loads its entries from. */
const MODULE = `export function makeHandler({ id }) { return { id, execute: async () => ({ data: {} }) }; }
export function makeAdapter({ id }) {
  return {
    id,
    fetch: async () => ({ status: 200, data: {} }),
    create: async () => ({ status: 201, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}
`;

const REMEDY = (kind: 'handler' | 'adapter', name: string): string =>
  `A runner that provides '${name}' can run it. Declare it under '${kind}s:' in realm.yaml or in ` +
  `the workflow's 'extensions' module, or correct the name.`;

/** Check 1's file: `sned_refund` where realm.yaml provides `send_refund`. */
const MISSPELT_HANDLER = `id: refunds
name: Refunds
version: 1
steps:
  refund:
    description: Send the refund.
    execution: auto
    handler: sned_refund
`;
const HANDLER_WORDS =
  "Step 'refund': handler 'sned_refund' is not one this project provides (it provides: " +
  'check_quotes, send_refund), so a run here is blocked at this step and stays open (not failed). ' +
  REMEDY('handler', 'sned_refund') +
  " Did you mean 'send_refund'?";
const HANDLER_FINDING = `⚠ ${HANDLER_WORDS} (line 8)`;

/** Check 2's file: a misspelt adapter on a service two steps use. */
const MISSPELT_ADAPTER = `id: notes
name: Notes
version: 1
services:
  mail:
    adapter: mailr
    trust: engine_delivered
steps:
  first:
    description: One.
    execution: auto
    uses_service: mail
    operation: send
  second:
    description: Two.
    execution: auto
    uses_service: mail
    operation: send
    depends_on: [first]
`;

/** Check 3's file: a cleanup step whose handler is misspelt. */
const MISSPELT_FINALIZER = `id: fin
name: Fin
version: 1
steps:
  work:
    description: Work.
    execution: auto
    handler: send_refund
  cleanup:
    description: Clean up.
    execution: finalizer
    handler: sned_refund
    on_outcome: [fail]
`;

/** Check 7's file: check 1's slip beside a pass-1 warning (an unknown `retry` key). */
const WITH_OTHER_WARNING = `id: refunds
name: Refunds
version: 1
steps:
  refund:
    description: Send the refund.
    execution: auto
    handler: sned_refund
    timeout_seconds: 30
    retry:
      max_attempts: 2
      bogus_key: 1
`;

describe('validate, register and watch — fix 1, piece 4: names the project does not provide', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-name-check-'));
    writeFileSync(join(dir, 'mod.mjs'), MODULE, 'utf8');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The project's realm.yaml: each handler and adapter name loads from `mod.mjs`. */
  function manifest(handlers: string[], adapters: string[] = []): void {
    const section = (kind: string, names: string[], factory: string): string[] =>
      names.length === 0
        ? []
        : [`${kind}:`, ...names.flatMap((n) => [`  ${n}:`, `    use: ./mod.mjs#${factory}`])];
    writeFileSync(
      join(dir, 'realm.yaml'),
      [
        'version: 1',
        ...section('handlers', handlers, 'makeHandler'),
        ...section('adapters', adapters, 'makeAdapter'),
        '',
      ].join('\n'),
      'utf8',
    );
  }
  function write(yaml: string): string {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    return file;
  }
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));
  /** Runs a command; its exit code (0 when it returned without one). */
  async function exitOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
    const call = exitSpy.mock.calls.at(-1);
    return call === undefined ? 0 : Number(call[0] ?? 0);
  }
  const validate = (args: string[]): Promise<number> =>
    exitOf(() => validateCommand.parseAsync(args, { from: 'user' }));

  it('check 1: `validate` warns with the list, the did-you-mean and the key’s line, and exits 0', async () => {
    manifest(['send_refund']);
    const code = await validate([write(MISSPELT_HANDLER)]);
    // (1) red when handler names are not judged (no warning), or the code is an error (exit 1);
    // (2) prints the warnings, errors and exit code.
    expect({ code, warnings: lines(warnSpy), errors: lines(errSpy) }).toEqual({
      code: 0,
      warnings: [HANDLER_FINDING],
      errors: [],
    });
    expect(lines(logSpy)).toContain('Valid: refunds v1 (1 step)');
  });

  it('check 1: `validate --strict` exits 1 on it, as on any warning', async () => {
    manifest(['send_refund']);
    const code = await validate([write(MISSPELT_HANDLER), '--strict']);
    // (1) red when the warning is not printed (strict passes); (2) prints the exit code and lines.
    expect({ code, warnings: lines(warnSpy) }).toEqual({ code: 1, warnings: [HANDLER_FINDING] });
  });

  it('check 1 twin: the right name gives nothing', async () => {
    manifest(['send_refund']);
    const code = await validate([write(MISSPELT_HANDLER.replace('sned_refund', 'send_refund'))]);
    // (1) red when a provided name is warned; (2) prints them.
    expect({ code, warnings: lines(warnSpy) }).toEqual({ code: 0, warnings: [] });
  });

  it('check 1: `register` stores the workflow and prints the warning', async () => {
    manifest(['send_refund']);
    write(MISSPELT_HANDLER);
    const code = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    // (1) red when the warning is not printed, or the code refuses (nothing stored); (2) prints them.
    expect({
      code,
      warnings: lines(warnSpy),
      stored: (await h.home.workflowStore.list()).map((d) => d.id),
    }).toEqual({ code: 0, warnings: [HANDLER_FINDING], stored: ['refunds'] });
  });

  it('check 2: a misspelt adapter on a service two steps use — words (b) once, naming the first step, at the adapter key', async () => {
    manifest([], ['mailer']);
    const code = await validate([write(MISSPELT_ADAPTER)]);
    // (1) red when adapters are not judged, each using step gets a finding, or the wrong step is
    // named; (2) prints them.
    expect({ code, warnings: lines(warnSpy) }).toEqual({
      code: 0,
      warnings: [
        "⚠ Service 'mail': adapter 'mailr' is not one this project provides (it provides: " +
          "filesystem, mailer), so each step that uses it ('first' is the first in the file) is " +
          'blocked when a run reaches it, and the run stays open (not failed). ' +
          REMEDY('adapter', 'mailr') +
          " Did you mean 'mailer'? (line 6)",
      ],
    });
  });

  it('check 3: a misspelt cleanup step handler gets words (c)', async () => {
    manifest(['send_refund']);
    const code = await validate([write(MISSPELT_FINALIZER)]);
    // (1) red when finalizers are not judged; (2) prints them.
    expect({ code, warnings: lines(warnSpy) }).toEqual({
      code: 0,
      warnings: [
        "⚠ Step 'cleanup': handler 'sned_refund' is not one this project provides (it provides: " +
          'check_quotes, send_refund), so when a run here ends in a way its ' +
          "'on_outcome' selects, this cleanup step is left pending instead of running. " +
          REMEDY('handler', 'sned_refund') +
          " Did you mean 'send_refund'? (line 12)",
      ],
    });
  });

  it('check 4: no project — a custom handler validated with no realm.yaml is warned, listing the built-ins', async () => {
    const code = await validate([write(MISSPELT_HANDLER.replace('sned_refund', 'my_custom'))]);
    // (1) red when a file with no realm.yaml is not judged; (2) prints them.
    expect({ code, warnings: lines(warnSpy) }).toEqual({
      code: 0,
      warnings: [
        "⚠ Step 'refund': handler 'my_custom' is not one this project provides (it provides: " +
          'check_quotes), so a run here is blocked at this step and stays open (not failed). ' +
          REMEDY('handler', 'my_custom') +
          ' (line 8)',
      ],
    });
  });

  it('check 5: sentinel mode — a skipped realm.yaml adapter entry still counts as provided, and its sentinel warning prints', async () => {
    writeFileSync(
      join(dir, 'realm.yaml'),
      "version: 1\nadapters:\n  shopify:\n    use: shopify\n    config:\n      shop_domain: '${secret:U4_SHOP_DOMAIN}'\n",
      'utf8',
    );
    const code = await validate([
      write(`id: shop
name: Shop
version: 1
services:
  store:
    adapter: shopify
    trust: engine_delivered
steps:
  a:
    description: A.
    execution: auto
    uses_service: store
    operation: get
`),
    ]);
    const warned = lines(warnSpy).join('\n');
    // (1) red when only the registry's built entries count (the skipped `shopify` is warned);
    // (2) prints the warnings.
    expect({
      code,
      notProvided: warned.includes('ADAPTER_NOT_PROVIDED') || warned.includes("adapter 'shopify'"),
      skipped: warned.includes('constructing adapters.shopify (use: shopify) failed'),
      sentinel: warned.includes('Validating with SENTINEL credentials'),
    }).toEqual({ code: 0, notProvided: false, skipped: true, sentinel: true });
  });

  it('check 7: the finding prints after the loader’s own warnings and before the sentinel warnings', async () => {
    writeFileSync(
      join(dir, 'realm.yaml'),
      "version: 1\nhandlers:\n  send_refund:\n    use: ./mod.mjs#makeHandler\nadapters:\n  shopify:\n    use: shopify\n    config:\n      shop_domain: '${secret:U4_SHOP_DOMAIN}'\n",
      'utf8',
    );
    const code = await validate([write(WITH_OTHER_WARNING)]);
    const warned = lines(warnSpy);
    const at = (needle: string): number => warned.findIndex((l) => l.includes(needle));
    const [retry, handler, skipped] = [
      at('bogus_key'),
      at("handler 'sned_refund'"),
      at('constructing adapters.shopify'),
    ];
    // (1) red when the finding is placed before pass 1's warnings or after the sentinel warnings;
    // (2) prints the places.
    expect({ code, retry, ordered: retry >= 0 && retry < handler && handler < skipped }).toEqual({
      code: 0,
      retry: expect.any(Number),
      ordered: true,
    });
  });

  it('check 7: `register` prints the new warning once, and every other warning once', async () => {
    manifest(['send_refund']);
    write(WITH_OTHER_WARNING);
    const code = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    const warned = lines(warnSpy);
    // (1) red when pass 2's findings are discarded (none), or every pass-2 warning is kept (the
    // retry key twice); (2) prints the warnings.
    expect({
      code,
      handler: warned.filter((l) => l.includes("handler 'sned_refund'")).length,
      retry: warned.filter((l) => l.includes('bogus_key')).length,
    }).toEqual({ code: 0, handler: 1, retry: 1 });
  });

  it('check 7: `watch` prints the new warning once, and every other warning once, and registers the file', async () => {
    manifest(['send_refund']);
    const file = write(WITH_OTHER_WARNING);
    const registered: WorkflowDefinition[] = [];
    const store: WorkflowRegistrar = {
      async register(def) {
        registered.push(def);
      },
      async get(id) {
        const found = registered.find((d) => d.id === id);
        if (!found) throw new Error(`Not found: ${id}`);
        return found;
      },
      async list() {
        return registered;
      },
    };
    const controller = new AbortController();
    const watching = watchWorkflow(file, store, controller.signal);
    try {
      await until(() => registered.length === 1);
      const warned = [...lines(warnSpy), ...lines(errSpy), ...lines(logSpy)];
      // (1) red when pass 2's findings are discarded, or every pass-2 warning is kept; (2) prints them.
      expect({
        registered: registered.length,
        handler: warned.filter((l) => l.includes("handler 'sned_refund'")).length,
        retry: warned.filter((l) => l.includes('bogus_key')).length,
      }).toEqual({ registered: 1, handler: 1, retry: 1 });
    } finally {
      controller.abort();
      await watching;
    }
  }, 20_000);

  it('check 7: `validate --registered` warns with no line when realm.yaml no longer provides the stored copy’s handler', async () => {
    manifest(['send_refund']);
    write(MISSPELT_HANDLER.replace('sned_refund', 'send_refund'));
    expect(await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }))).toBe(0);
    expect(lines(warnSpy)).toEqual([]);
    manifest(['other_handler']);
    warnSpy.mockClear();
    const code = await validate(['--registered', 'refunds']);
    // (1) red when --registered discards the extensions pass's findings, or gives a line; (2) prints them.
    expect({ code, warnings: lines(warnSpy) }).toEqual({
      code: 0,
      warnings: [
        "⚠ Step 'refund': handler 'send_refund' is not one this project provides (it provides: " +
          'check_quotes, other_handler), so a run here is blocked at this step and stays open (not ' +
          'failed). ' +
          REMEDY('handler', 'send_refund'),
      ],
    });
  });
});

describe('the words — fix 1, piece 4', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

  it('check 9: handlers.md says validate, register and watch warn, and no longer that they do not check', () => {
    const page = read('docs/reference/handlers.md');
    // (1) red when the new sentence is missing or the old one stays; (2) prints both checks.
    expect({
      now: page.includes(
        "`realm workflow validate`, `register` and `watch` warn when a step's handler is not one the project provides (`HANDLER_NOT_PROVIDED`, added after version 0.49.0), and still accept the workflow: another runner may provide it. Version 0.49.0 accepted it with no word.",
      ),
      old: page.includes(
        "`realm workflow validate` and `realm workflow register` do not check that a step's handler is registered.",
      ),
    }).toEqual({ now: true, old: false });
  });

  it('check 9: loader-diagnostics.md has the two rows after PARAMS_MAP_UNDECLARED_PARAM', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/workflow/loader-diagnostics.md'), 'utf8');
    const rows = page
      .split('\n')
      .filter((l) => /^\| `[A-Z_]+` +\|/.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    const at = rows.findIndex((r) => r[0] === '`PARAMS_MAP_UNDECLARED_PARAM`');
    // (1) red when a row is missing, moved or reworded; (2) prints the two rows.
    expect(rows.slice(at + 1, at + 3)).toEqual([
      [
        '`HANDLER_NOT_PROVIDED`',
        'Warning',
        "A step's handler is not one the project provides. Added after version 0.49.0.",
      ],
      [
        '`ADAPTER_NOT_PROVIDED`',
        'Warning',
        "The adapter a step's service names is not one the project provides. Added after version 0.49.0.",
      ],
    ]);
  });

  it('check 9: the CHANGELOG line under [Unreleased] → Changed', () => {
    const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const start = log.indexOf('## [Unreleased]');
    const unreleased = log.slice(start, log.indexOf('\n## [', start + 1));
    const changed = unreleased.slice(
      unreleased.indexOf('### Changed'),
      unreleased.indexOf('### Fixed'),
    );
    // (1) red when the line is missing or moved out of Changed; (2) prints the check.
    expect(
      changed.includes(
        '- `realm workflow validate`, `register` and `watch` warn when the handler or adapter a step needs is not one the project provides, naming what it does provide and, when one is close, a did-you-mean. Such a step was blocked when it ran (a cleanup step was left pending), with no word at load. It is a warning, not a refusal, because another runner may provide the name; `--strict` fails on it, as on any warning.',
      ),
    ).toBe(true);
  });
});

/** Waits until `cond()` holds, polling (watch.test.ts's helper). */
async function until(cond: () => boolean, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
