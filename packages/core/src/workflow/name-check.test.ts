// Fix 1, piece 4 — a handler or adapter a step needs that the project does not provide, warned when
// the file loads with the project's registry (`loadWorkflowFromStringWithDiagnostics` with a
// registry and the names realm.yaml declares). The command cells (validate's exit, `--strict`,
// register, watch, `--registered`, sentinel mode, the runs, the docs) are in the CLI's
// validate-name-check.test.ts and name-check-runs.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u4-names.md).
import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import { DEFAULT_POLICY, resolveSeverity } from './diagnostics.js';
import type { DeclaredNames } from './name-check.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const CODES = new Set(['HANDLER_NOT_PROVIDED', 'ADAPTER_NOT_PROVIDED']);

/** The loader's piece-4 findings for `yaml`, loaded with `registry` and `declared`. */
function findings(
  yaml: string,
  declared?: DeclaredNames,
  registry: ExtensionRegistry = createDefaultRegistry(),
) {
  return loadWorkflowFromStringWithDiagnostics(yaml, registry, declared).warnings.filter((w) =>
    CODES.has(w.code),
  );
}

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

/** Check 2's file: a misspelt adapter on a service two steps use; a second service no step uses. */
const MISSPELT_ADAPTER = `id: notes
name: Notes
version: 1
services:
  mail:
    adapter: mailr
    trust: engine_delivered
  unused:
    adapter: bogus_unused
    trust: engine_delivered
steps:
  first:
    description: One.
    execution: auto
    uses_service: mail
    operation: send
    handler: not_a_handler
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

describe('fix 1, piece 4 — a handler or adapter the project does not provide', () => {
  it('the two codes are warnings (never a refusal)', () => {
    // (1) red when either code is 'error'; (2) prints both severities.
    expect({
      handler: resolveSeverity('HANDLER_NOT_PROVIDED'),
      adapter: resolveSeverity('ADAPTER_NOT_PROVIDED'),
      inPolicy: [DEFAULT_POLICY.HANDLER_NOT_PROVIDED, DEFAULT_POLICY.ADAPTER_NOT_PROVIDED],
    }).toEqual({ handler: 'warn', adapter: 'warn', inPolicy: ['warn', 'warn'] });
  });

  it('check 1: a misspelt handler gets words (a), the list, the did-you-mean and the key’s line', () => {
    const got = findings(MISSPELT_HANDLER, { handlers: ['send_refund'] });
    // (1) red when handler names are not judged, or the words, list, did-you-mean or line change;
    // (2) prints the findings.
    expect(got).toEqual([
      {
        code: 'HANDLER_NOT_PROVIDED',
        severity: 'warn',
        message:
          "Step 'refund': handler 'sned_refund' is not one this project provides (it provides: " +
          'check_quotes, send_refund), so a run here is blocked at this step and stays open (not ' +
          'failed). ' +
          REMEDY('handler', 'sned_refund') +
          " Did you mean 'send_refund'? (line 8)",
        scope: 'step',
        step: 'refund',
        key: 'sned_refund',
        did_you_mean: 'send_refund',
        line: 8,
        column: expect.any(Number),
        endLine: 8,
        endColumn: expect.any(Number),
      },
    ]);
  });

  it('check 1 twin: the right name gives nothing', () => {
    const yaml = MISSPELT_HANDLER.replace('sned_refund', 'send_refund');
    // (1) red when a provided name is warned; (2) prints the findings.
    expect(findings(yaml, { handlers: ['send_refund'] })).toEqual([]);
  });

  it('check 2: a misspelt adapter on a service two steps use is warned once, naming the first step, at the adapter key', () => {
    const got = findings(MISSPELT_ADAPTER, { adapters: ['mailer'] });
    // (1) red when adapters are not judged; when every declared service is judged (`unused` too);
    // when the handler beside uses_service is judged; when each using step gets a finding; when the
    // wrong step is named; (2) prints the findings.
    expect(got.map((w) => ({ ...w, column: undefined, endColumn: undefined }))).toEqual([
      {
        code: 'ADAPTER_NOT_PROVIDED',
        severity: 'warn',
        message:
          "Service 'mail': adapter 'mailr' is not one this project provides (it provides: " +
          "filesystem, mailer), so each step that uses it ('first' is the first in the file) is " +
          'blocked when a run reaches it, and the run stays open (not failed). ' +
          REMEDY('adapter', 'mailr') +
          " Did you mean 'mailer'? (line 6)",
        scope: 'workflow',
        key: 'mailr',
        did_you_mean: 'mailer',
        line: 6,
        column: undefined,
        endLine: 6,
        endColumn: undefined,
      },
    ]);
  });

  it('check 2 twin: the steps in the other order name the other step as the first in the file', () => {
    const yaml = `id: notes
name: Notes
version: 1
services:
  mail:
    adapter: mailr
    trust: engine_delivered
steps:
  second:
    description: Two.
    execution: auto
    uses_service: mail
    operation: send
  first:
    description: One.
    execution: auto
    uses_service: mail
    operation: send
`;
    // (1) red when the step named is not the first in the file that uses the service; (2) prints it.
    expect(findings(yaml, { adapters: ['mailer'] }).map((w) => w.message)).toEqual([
      expect.stringContaining("('second' is the first in the file)"),
    ]);
  });

  it('check 2 twin: the same misspelt adapter on a service no step uses gives nothing', () => {
    const yaml = MISSPELT_ADAPTER.replace('adapter: mailr', 'adapter: mailer');
    // (1) red when every declared service is judged (`unused`'s `bogus_unused`); (2) prints them.
    expect(findings(yaml, { adapters: ['mailer'] })).toEqual([]);
  });

  it('check 2 twin: uses_service with a bogus handler gives only the adapter’s finding, or none when the adapter is provided', () => {
    // (1) red when the step's handler is judged beside uses_service; (2) prints the codes.
    expect({
      adapterMissing: findings(MISSPELT_ADAPTER, { adapters: ['mailer'] }).map(
        (w) => `${w.code} ${w.key}`,
      ),
      adapterProvided: findings(MISSPELT_ADAPTER, { adapters: ['mailer', 'mailr'] }).map(
        (w) => `${w.code} ${w.key}`,
      ),
    }).toEqual({ adapterMissing: ['ADAPTER_NOT_PROVIDED mailr'], adapterProvided: [] });
  });

  it('check 3: a misspelt cleanup step handler gets words (c)', () => {
    const got = findings(MISSPELT_FINALIZER, { handlers: ['send_refund'] });
    // (1) red when finalizers are not judged, or get words (a); (2) prints the findings.
    expect(got.map((w) => `${w.code} [${w.step}]: ${w.message}`)).toEqual([
      "HANDLER_NOT_PROVIDED [cleanup]: Step 'cleanup': handler 'sned_refund' is not one this " +
        'project provides (it provides: check_quotes, send_refund), so when a run here ends in a ' +
        "way its 'on_outcome' selects, this cleanup step, and every cleanup step after it, is left " +
        'pending instead of running. ' +
        REMEDY('handler', 'sned_refund') +
        " Did you mean 'send_refund'? (line 12)",
    ]);
  });

  it('check 4: no project — a custom handler is warned against the built-in registry, listing the built-ins', () => {
    const yaml = MISSPELT_HANDLER.replace('sned_refund', 'my_custom');
    // (1) red when the built-in registry is not judged, or the list is not the built-ins; (2) prints it.
    expect(findings(yaml).map((w) => w.message)).toEqual([
      "Step 'refund': handler 'my_custom' is not one this project provides (it provides: " +
        'check_quotes), so a run here is blocked at this step and stays open (not failed). ' +
        REMEDY('handler', 'my_custom') +
        ' (line 8)',
    ]);
  });

  it('check 5: a name realm.yaml declares counts as provided when the registry lacks it (a sentinel-skipped entry)', () => {
    const yaml = MISSPELT_ADAPTER.replace('adapter: mailr', 'adapter: shopify');
    // (1) red when only the registry's (built) entries count; (2) prints the findings.
    expect({
      declared: findings(yaml, { adapters: ['shopify'] }),
      notDeclared: findings(yaml, {}).map((w) => `${w.code} ${w.key}`),
    }).toEqual({ declared: [], notDeclared: ['ADAPTER_NOT_PROVIDED shopify'] });
  });

  it('no registry loaded (run, agent, listen, test, create_workflow): nothing is judged', () => {
    // (1) red when the check runs without the project's registry; (2) prints the findings.
    const got = loadWorkflowFromStringWithDiagnostics(MISSPELT_HANDLER).warnings;
    expect(got.filter((w) => CODES.has(w.code))).toEqual([]);
  });

  it('the list is sorted, at most ten names, then "and <n> more"', () => {
    const registry = new ExtensionRegistry();
    const impl = { execute: async () => ({ data: {} }) } as unknown as StepHandler;
    for (const n of ['h12', 'h03', 'h01', 'h09', 'h11', 'h05', 'h07', 'h02', 'h10', 'h04', 'h08'])
      registry.register('handler', n, impl);
    const got = findings(MISSPELT_HANDLER, { handlers: ['h06'] }, registry);
    // (1) red when the list is unsorted, uncapped, or the count is wrong; (2) prints the message.
    expect(got.map((w) => w.message)).toEqual([
      expect.stringContaining(
        '(it provides: h01, h02, h03, h04, h05, h06, h07, h08, h09, h10 and 2 more)',
      ),
    ]);
  });

  it('no line when the source carries none (a stored copy, JSON)', () => {
    const json = JSON.stringify({
      id: 'refunds',
      name: 'Refunds',
      version: 1,
      steps: { refund: { description: 'Send.', execution: 'auto', handler: 'sned_refund' } },
    });
    const [w] = findings(json, { handlers: ['send_refund'] });
    // (1) red when a line is invented for a source with no positions; (2) prints the finding.
    expect({ line: w?.line, endsWith: w?.message.endsWith("Did you mean 'send_refund'?") }).toEqual(
      { line: undefined, endsWith: true },
    );
  });

  it('not judged: an agent step’s handler, an auto step with neither, a non-string handler', () => {
    const yaml = `id: nj
name: NJ
version: 1
steps:
  ask:
    description: Ask.
    execution: agent
    handler: nope_agent
  plain:
    description: Plain.
    execution: auto
  numeric:
    description: Numeric.
    execution: auto
    handler: 42
  cleanup:
    description: Clean.
    execution: finalizer
    handler: 7
    on_outcome: always
`;
    // (1) red when an agent step's handler, or a non-string name, is judged; (2) prints them.
    expect(findings(yaml, {})).toEqual([]);
  });

  it('every finding comes in the steps’ file order', () => {
    const yaml = `id: order
name: Order
version: 1
services:
  mail:
    adapter: mailr
    trust: engine_delivered
steps:
  b:
    description: B.
    execution: auto
    handler: hb
  a:
    description: A.
    execution: auto
    uses_service: mail
    operation: send
  c:
    description: C.
    execution: finalizer
    handler: hc
    on_outcome: always
`;
    // (1) red when the findings are not in the steps' order; (2) prints the codes and keys.
    expect(findings(yaml, {}).map((w) => `${w.code} ${w.key}`)).toEqual([
      'HANDLER_NOT_PROVIDED hb',
      'ADAPTER_NOT_PROVIDED mailr',
      'HANDLER_NOT_PROVIDED hc',
    ]);
  });
  it('correction 1 (a): a service with no value (YAML null) that a step uses is skipped — no throw, no finding', () => {
    const yaml = `id: nullsvc
name: Null service
version: 1
services:
  mail:
steps:
  a:
    description: A.
    execution: auto
    uses_service: mail
    operation: send
    handler: not_a_handler
`;
    // (1) red when the service's value is read as a map (the TypeError), or the step's handler is
    // judged instead; (2) prints the findings.
    expect(findings(yaml, {})).toEqual([]);
  });

  it('correction 1 (a) twin: a service with a value beside the null one is still judged', () => {
    const yaml = `id: nullsvc
name: Null service
version: 1
services:
  mail:
  store:
    adapter: stor
    trust: engine_delivered
steps:
  a:
    description: A.
    execution: auto
    uses_service: mail
    operation: send
  b:
    description: B.
    execution: auto
    uses_service: store
    operation: get
`;
    // (1) red when the skip drops every service; (2) prints the codes and keys.
    expect(findings(yaml, {}).map((w) => `${w.code} ${w.key}`)).toEqual([
      'ADAPTER_NOT_PROVIDED stor',
    ]);
  });

  it("correction 1 (b): a handler taken through a YAML merge key gets the step's line, named as the step's", () => {
    const yaml = `id: merge
name: Merge
version: 1
steps:
  a: &base
    description: A.
    execution: auto
    handler: sned_refund
  b:
    <<: *base
    description: B.
`;
    // (1) red when the fallback is removed (no line) or names no anchor; (2) prints the endings.
    expect(
      findings(yaml, { handlers: ['send_refund'] }).map((w) => ({
        step: w.step,
        end: w.message.slice(w.message.lastIndexOf('?') + 1),
        line: w.line,
      })),
    ).toEqual([
      { step: 'a', end: ' (line 8)', line: 8 },
      { step: 'b', end: ' (step at line 9)', line: undefined },
    ]);
  });
});
