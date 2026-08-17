// input-map-directives.test.ts — issue #287, the LOADER layer of the directive gate.
//
// The originating incident: a workflow shipped
//   filter_by_formula: { $template: "{ticket_id}=\"{{run.params.ticket_id}}\"" }
// `$template` has never existed. The loader accepted it, the runtime resolved the directive's
// value as a context path (yielding undefined), and the adapter silently dropped the mistyped
// param — so an Airtable query ran UNFILTERED and reported success for five weeks, corrupting
// 907 downstream records.
//
// The runtime mirror of this gate is pinned in engine/input-map.test.ts; the two layers are
// deliberately independent (either alone catches the class, which the mutation probes show).
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';

/** A single auto step whose input_map body is supplied by the caller (YAML-indented 6 spaces). */
function wf(inputMapBody: string): string {
  return `
id: directive-wf
name: Directive Workflow
version: 1
services:
  airtable:
    adapter: airtable
    trust: engine_delivered
steps:
  fetch:
    description: Fetch records
    execution: auto
    uses_service: airtable
    service_method: fetch
    operation: list_records
    input_map:
${inputMapBody}
`;
}

function loadError(inputMapBody: string): string {
  try {
    loadWorkflowFromString(wf(inputMapBody));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the workflow to FAIL loading, but it loaded');
}

describe('input_map directive gate — loader (issue #287)', () => {
  // (a) THE INCIDENT CELL, verbatim.
  it('(a) the incident: `filter_by_formula: {$template: …}` fails to LOAD, naming step, param, directive, and the remedy', () => {
    const message = loadError(
      `      filter_by_formula:\n        $template: '{ticket_id}="{{run.params.ticket_id}}"'`,
    );
    expect(message).toContain("Step 'fetch'");
    expect(message).toContain('filter_by_formula');
    expect(message).toContain("unknown directive '$template'");
    expect(message).toContain('supported directives: $literal');
    // The unconditional line: it answers the question the incident's author actually had.
    expect(message).toContain('templated strings are not supported');
  });

  // (b) BREADTH.
  it('(b) an unknown $-key is rejected at top level, nested, and deep', () => {
    expect(loadError('      x:\n        $weird: run.params.a')).toContain(
      "unknown directive '$weird'",
    );
    const nested = loadError('      a:\n        b:\n          $weird: run.params.a');
    expect(nested).toContain("unknown directive '$weird'");
    expect(nested).toContain('path "a" path "b"'); // the path is named, not just the key
  });

  it('(b) `$$literal` is rejected — the whole $ prefix is RESERVED, which keeps a future escape addable', () => {
    expect(loadError('      x:\n        $$literal: 5')).toContain("unknown directive '$$literal'");
  });

  it('(b) valid trees still load: $literal alone, plain paths, nested maps', () => {
    expect(() => loadWorkflowFromString(wf('      x:\n        $literal: 5'))).not.toThrow();
    expect(() =>
      loadWorkflowFromString(wf('      x:\n        $literal:\n          a: 1')),
    ).not.toThrow();
    expect(() => loadWorkflowFromString(wf('      x: run.params.a'))).not.toThrow();
    expect(() => loadWorkflowFromString(wf('      x:\n        y: run.params.a'))).not.toThrow();
  });

  it('(b) `{$literal, $unknown}` fires the SIBLING error first — the placement pin', () => {
    const message = loadError('      x:\n        $literal: 1\n        $unknown: 2');
    expect(message).toContain('$literal node must have exactly one key');
    // The directive gate must not ALSO fire here: the sibling message names the more specific
    // mistake, and the gate is deliberately placed after the $literal block to preserve that.
    expect(message).not.toContain("unknown directive '$unknown'");
  });

  it('(b) did-you-mean fires for a near miss and stays SILENT for a far name', () => {
    expect(loadError('      x:\n        $litteral: 5')).toContain("Did you mean '$literal'?");
    // `$template` is far from `$literal`; a guess there would be misleading. The fixed remedy
    // is the floor — it must still be present.
    const far = loadError('      x:\n        $template: run.params.a');
    expect(far).not.toContain('Did you mean');
    expect(far).toContain('supported directives: $literal');
    expect(far).toContain('wrap the subtree in $literal');
  });

  // Ride-along (boy-scout, labeled; NOT the reported gap): the loader's DEPTH arm had zero suite
  // coverage — the same shape as the runtime one pinned in engine/input-map.test.ts. Both layers
  // refuse an over-nested input_map; neither was exercised until now.
  it('(ride-along) an input_map nested past the maximum depth fails to LOAD, naming the path and the limit', () => {
    // 11 levels below the param — one past the limit. VERIFIED by execution: 8 loads fine.
    let body = '';
    const DEPTH = 11;
    for (let i = 0; i < DEPTH; i += 1) body += `${' '.repeat(8 + i * 2)}k${i}:\n`;
    body += `${' '.repeat(8 + DEPTH * 2)}leaf: run.params.a`;
    const message = loadError(`      top:\n${body}`);
    expect(message).toContain('exceeded maximum nesting depth of 10');
    expect(message).toContain('input_map path "top"');
  });

  it('(b) the escape works: a literal subtree containing $-keys loads when wrapped in $literal', () => {
    // The remedy the error text recommends must actually be valid — otherwise the message sends
    // the author into a second failure.
    expect(() =>
      loadWorkflowFromString(wf('      x:\n        $literal:\n          $template: hello')),
    ).not.toThrow();
  });
});
