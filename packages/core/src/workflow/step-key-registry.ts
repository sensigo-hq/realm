// step-key-registry.ts — issue #417 PR-2 (the map) + #517 (the drive-flip: MINTS the
// kind-prohibitions FROM these cells).
//
// Every member of KNOWN_STEP_KEYS crossed with every ExecutionMode (36 × 4 = 144 cells) is
// classified here with evidence: where the engine actually reads it, where the loader refuses it
// — since #517, the loader's per-step walk looks every declared key up here and MINTS exactly one
// refusal per key × kind, with the message text carried as per-cell data; companion/value rules
// stay hand-written (the clang line) — and, where it is accepted but does nothing, WHY that
// silence is not actually silent (an advisory code, a written waiver, or an issue tracking a real
// defect). The `satisfies` clause at the bottom of this file turns a missing key or a missing kind
// into a COMPILE error: a new step key cannot ship without a row here.
//
// LITERAL-ONLY DISCIPLINE (design-d2 F7): STEP_KEY_REGISTRY below is a plain object literal.
// Any derived/mapped construction — spreading over KNOWN_STEP_KEYS, Object.fromEntries, a helper
// that builds cells programmatically — defeats the point: `satisfies` can only catch a missing
// property on a LITERAL. Do not refactor this into something clever.
//
// WITNESS DISCIPLINE (design-d2 F1/F6, enforced by both conformance runners):
//   1. Every pattern is matched against COMMENT-STRIPPED, WHITESPACE-NORMALIZED source
//      (`normalizeSource`, below — applied identically to the haystack and the needle).
//   2. Every witness asserts an EXACT count (default 1, override via `count`). A legitimate
//      future consolidation of call sites is a one-line registry edit, never a loosened match.
//   3. Every pattern is a call or read SHAPE — a receiver plus an operator, or a call paren —
//      never a bare identifier that could match anywhere.
//   4. (#517, the by[]-successor model) Every MINTED prohibition's `by[]` is the ONE shared
//      MINT witness — the mint walk's own error-construction shape in yaml-loader.ts. The old
//      per-key firing conditions and the two prohibition loops that used to back this rule are
//      gone; membership truth now lives in the DERIVED exports `GUARD_PROHIBITED_STEP_KEYS` /
//      `FINALIZER_PROHIBITED_STEP_KEYS`, which are computed FROM this registry
//      (`prohibitedKeysFor`) — so the old both-directions membership assertion became an
//      identity and was retired along with the loops it checked. Except-bearing cells and
//      `blocked_transitive` cells keep their own live, hand-written witnesses below.
//
// THE WITNESS-COLLISION CLASS: a witness is code-shaped text, which means it is visible to every
// OTHER line-based source-text guard in this suite too (the #369 preconditions call-site walker,
// which counts comment lines as well as code — it has redded twice against a careless witness
// spelling during this arc). The fix is never to weaken an existing guard; it is to respell THIS
// file's witness to avoid the trigger string (e.g. quoting the Step-2a READ shape rather than the
// call text a walker is specifically counting). A collision always manifests as an EXISTING
// unrelated cell going red while this file's own tests are green.
//
// MESSAGE_DATA (#517, SHIPPED): where a prohibition mints one of the bespoke four-clause
// messages, the INVARIANT TAIL of that message — every byte after the shared `Step '<name>': `
// prefix, before any positional `(line N)`/`(step at line N)` suffix — IS the loader's minted
// text for that cell (the mint renders this data verbatim), asserted byte-CONTAINED (never
// byte-equal; the step name and the line cite both interpolate) by the behavioral cells below.
// Post-flip these containment cells are mint-plumbing pins — the permanent floor; the one-time
// byte-parity proof against the PRE-flip, hand-written checks was the golden run
// (plans/issue-417-pr2/golden-compare.mjs, captured at merge-base fb752ef). This also rides the
// `blocked_transitive` arm for the #413 tool_timeout texts, asserted on leg A only — a drift lock,
// nothing more: the mint never mints a companion-rule message from this data, since companion
// rules stay hand-written (the D3 amendment's clang line). Where one loader message serves more
// than one kind (a shared const), every cell minting it points at the SAME string, so a
// corruption of that text reds every sharer at once — by design, not an accident.
//
// MISCLASSIFICATION-DETECTION LIMIT (D4-4): the two-leg blocked_transitive assertion catches a
// `prohibited` cell wrongly re-armed as `blocked_transitive` (leg B demands zero naming errors,
// and a real kind rule keeps firing) but NOT the reverse — a true blocked_transitive cell
// mislabelled `prohibited` simply loses its leg B, and leg A's ≥1-naming assertion is satisfied
// either way. The companion-pattern lock in the test file catches the KNOWN instance of this
// (any companion-shaped by-witness, e.g. tool_timeout's toolsMissing check, appearing on a
// `prohibited` cell) mechanically; a future companion rule not yet in that pattern list falls
// back to review. This is a stated, accepted residual, not an oversight.
//
// DUPLICATE-CELL DISPOSITION (design-d2 F13): the behavioral cells here are a DIFFERENT mechanism
// (data-driven, TCK-shaped conformance) from the hand-written per-key pins already living in
// yaml-loader.test.ts. They deliberately coexist. Do not dedupe either side.
import type { WarningCode } from './diagnostics.js';
import { KNOWN_STEP_KEYS } from '../types/workflow-definition.js';
import type { ExecutionMode } from '../types/workflow-definition.js';

export type StepKeyWitness = { file: string; pattern: string; count?: number };

export type StepKeyVia =
  | { kind: 'advisory'; code: WarningCode }
  | { kind: 'waived'; reason: string }
  | { kind: 'tracked'; issue: `#${number}` };

export type StepKeyCell =
  | {
      c: 'consumed';
      where: StepKeyWitness[];
      when?: { desc: string; witness: StepKeyWitness };
      inert_subpop?: Array<{ desc: string; via: StepKeyVia }>;
    }
  | {
      c: 'prohibited';
      by: StepKeyWitness[];
      line: 'key' | 'path' | 'step';
      except?: { desc: string; via: StepKeyVia };
      message_data?: string;
      /** #517: the minted FRONT-CLAUSE grammar for a GENERIC (no-`message_data`) minted cell.
       *  'not_valid'  → `'X' is not valid on execution: <this cell's kind> steps` — the historical
       *                 kind-prohibition-loop grammar, preserved byte-for-byte (golden-proven).
       *  'only_valid' → `'X' is only valid on execution: <derived consumed kinds> steps` — the
       *                 historical twin-only grammar; the valid-kind set is DERIVED from this
       *                 registry's own consumed cells (`consumedKindsFor`), never typed by hand.
       *  Exactly the generic minted population carries this field: `message_data` XOR `front` on
       *  every minted cell, and neither on an `except` cell — a conformance cell asserts the
       *  partition. */
      front?: 'not_valid' | 'only_valid';
    }
  | {
      c: 'blocked_transitive';
      via: (typeof KNOWN_STEP_KEYS)[number];
      by: StepKeyWitness[];
      message_data?: string;
    }
  | { c: 'inert'; via: StepKeyVia }
  | { c: 'na'; reason: string };

/** Strips block and line comments, then collapses every whitespace run to a single space. Run on
 *  BOTH the real source and the registry's own pattern before matching, so a pattern can be
 *  written as a readable one-line slice of code that may itself span or sit beside comments in
 *  the file. The single-char lookback on `//` keeps a `https://…` literal from being truncated as
 *  if it opened a line comment.
 *
 *  Deliberately a manual, single left-to-right scan rather than the equivalent lazy-regex pair
 *  (`/\/\*[\s\S]*?\*\//g` + a lookback-guarded `//` strip) that a first draft of this file
 *  shipped: CodeQL flagged that pair as a genuine polynomial-time DoS — a run of unterminated
 *  `/*` occurrences (no closing `*\/` anywhere after them) forces a full failed scan-to-end for
 *  EACH occurrence, which is quadratic in the number of occurrences. The scan below still does at
 *  most one `indexOf` per comment opener, but a failed `indexOf` (no closer anywhere in the rest
 *  of the string) ends the whole pass immediately — linear, not quadratic, in the worst case. */
export function normalizeSource(text: string): string {
  let out = '';
  const n = text.length;
  let i = 0;
  // Once a single `indexOf('*/', k)` call returns -1, no `/*` found at any LATER position can
  // ever close either — its search range is a strict suffix of the one that already failed. This
  // flag turns that monotonicity into a hard cap of ONE failed full-length scan for the entire
  // call, however many unclosed `/*` occurrences follow — without it, a string built from many
  // `/*` openers and no closer anywhere would cost one failed O(remaining-length) scan PER
  // opener, which is exactly the quadratic shape CodeQL flagged in the lazy-regex draft this
  // replaced.
  let noMoreBlockClosersAhead = false;
  while (i < n) {
    const ch = text[i];
    const nextCh = i + 1 < n ? text[i + 1] : '';
    if (!noMoreBlockClosersAhead && ch === '/' && nextCh === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        // No closer anywhere ahead — the original regex would fail to match here too, leaving
        // this `/*` as literal text. Emit it as-is and continue scanning normally; the flag
        // above stops this branch from ever paying for another full scan.
        noMoreBlockClosersAhead = true;
        out += ch;
        i += 1;
      } else {
        out += ' ';
        i = close + 2;
      }
      continue;
    }
    if (ch === '/' && nextCh === '/') {
      const prevCh = i === 0 ? '' : text[i - 1];
      if (prevCh === ':' || prevCh === '"' || prevCh === "'") {
        out += ch;
        i += 1;
        continue;
      }
      const newlineAt = text.indexOf('\n', i);
      i = newlineAt === -1 ? n : newlineAt; // the newline itself, if any, is left for the next pass
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, ' ');
}

/** Exact non-overlapping occurrence count of `pattern` inside `source`, both normalized first. */
export function countWitnessMatches(source: string, pattern: string): number {
  const hay = normalizeSource(source);
  const needle = normalizeSource(pattern).trim();
  if (needle.length === 0) return 0;
  let count = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return count;
}

// File-path shorthands, repo-root-relative — the convention purge-guard.test.ts already
// established for a cross-package source-text read: each conformance runner resolves these from
// its own package location, never from cwd.
const EL = 'packages/core/src/engine/execution-loop.ts';
const ELIG = 'packages/core/src/engine/eligibility.ts';
const SETTLE = 'packages/core/src/engine/settlement.ts';
const CL = 'packages/core/src/engine/claim-liveness.ts';
const YL = 'packages/core/src/workflow/yaml-loader.ts';
const RA = 'packages/cli/src/agent/run-agent.ts';
const RECLAIM = 'packages/cli/src/commands/reclaim.ts';
const GEN = 'packages/mcp-server/src/protocol/generator.ts';

// #517 (the drive-flip): every minted prohibition's `by[]` carries this ONE witness — the mint
// walk's own error-construction shape in yaml-loader.ts, exact-count 1. The per-key hand-written
// firing conditions these cells used to cite, and the two kind-prohibition loops, are DELETED by
// the flip; the mint is now the single enforcement mechanism, so this one shared witness is the
// truthful successor (a corruption of the walk reds every minted cell's witness check at once —
// by design). Except-bearing and `blocked_transitive` cells keep their own live, hand-written
// witnesses below.
export const MINT_WITNESS_PATTERN =
  "errors.push( withKeyLine( stepName, key, `Step '${stepName}': ${renderRegistryProhibition(key, kind, cell)}`,";
const MINT: StepKeyWitness = { file: YL, pattern: MINT_WITNESS_PATTERN };

// ——— message_data: the invariant tails of the shipped bespoke messages (see header) ———
const MSG_ON_OUTCOME =
  "'on_outcome' is only valid on execution: finalizer steps — it selects which finalizers run " +
  'for a given outcome, and only finalizers are selected that way, so here it would decide ' +
  'nothing. Move it to the finalizer that should react to the outcome, or remove it.';
const MSG_ABORT_UNLESS =
  "'abort_unless' is only valid on execution: guard steps — it is the condition list a guard " +
  'evaluates before letting the run continue, and only guard steps are evaluated that way, so ' +
  'here it would gate nothing. Put the check on a guard step, or remove it.';
const MSG_ABORT_MESSAGE =
  "'abort_message' is only valid on execution: guard steps — it is the text reported when a " +
  'guard aborts the run, and nothing but a guard reads it, so here it would never be read. ' +
  'Move it to the guard that performs the abort, or remove it.';
const MSG_AGENT_PROFILE =
  "'agent_profile' is only valid on execution: agent steps — its content is resolved into the " +
  'model prompt, and only an agent step makes a model request, so here it would reach no ' +
  'model. Move it to the agent step whose prompt it should shape, or remove it.';
const MSG_LLM_TIMEOUT =
  "'llm_timeout_seconds' is only valid on execution: agent steps — it bounds one model " +
  'request, and no other kind makes one, so here it would bound nothing. Move it to the agent ' +
  "step whose request it should bound, or remove it. An auto step's dispatch is bounded by " +
  "'timeout_seconds', and a finalizer's handler by its own 'timeout_seconds'.";
const MSG_IDEMPOTENT =
  "'idempotent' is only valid on execution: auto steps — it gates 'retry.on_timeout' and " +
  'reclaim eligibility, and both act on auto dispatch, so here it would gate nothing. Remove ' +
  'it, or move the work to an auto step if you need either.';
const MSG_TIMEOUT_ON_AGENT =
  "'timeout_seconds' is not valid on execution: agent steps — the engine never enforces it " +
  'there (agent dispatch is never wrapped in a timeout), so the step would LOOK time-bounded ' +
  "while nothing enforced the bound. In realm's own drive the model request is bounded by " +
  "'llm_timeout_seconds' (or --llm-timeout) and tool calls by 'tool_timeout'.";
const MSG_PRECONDITIONS_GUARD =
  "'preconditions' is not valid on execution: guard steps — the engine never evaluates it " +
  "there (a guard's execution evaluates only 'abort_unless'), so the run would LOOK guarded " +
  "while the declared check never ran. Move the condition into 'abort_unless'. Whether guards " +
  'gain a live condition surface is an open design question (issue #366) — if admitted later, ' +
  'existing workflows are unaffected.';
const MSG_TOOL_TIMEOUT =
  "'tool_timeout' requires 'tools' (a declared, non-empty list) — without tool calls there is " +
  'nothing for it to bound, so the step would carry a bound with nothing to bind. In ' +
  "realm's own drive each tool call is capped at tool_timeout seconds (default 30); declare " +
  'at least one tool or remove the key.';

// ——— surviving hand-written by-witnesses (#517): only the except-bearing trust×finalizer
// value-conditional check and the blocked_transitive tool_timeout companion check keep live
// per-key firing conditions in the loader; every other prohibition is minted (MINT, above) ———
const BY_TOOL_TIMEOUT: StepKeyWitness = {
  file: YL,
  pattern: "if (step['tool_timeout'] !== undefined && toolsMissing) {",
};
const BY_TRUST_FINALIZER: StepKeyWitness = {
  file: YL,
  pattern: "if (step['trust'] !== undefined && step['trust'] !== 'auto') {",
};

// ——— recurring consumed witnesses (shared across more than one cell, and — new in #517 — also
// referenced as a CONSUMED_HOME.site: the message's factual citation IS the tested witness) ———
const W_WHEN_ELIG: StepKeyWitness = {
  file: ELIG,
  pattern: 'if (!evaluateWhen(step.when, evidenceByStep, run.params)) continue;',
  count: 2, // DAG eligibility's own check + the guard-selection walk share the same evaluator call
};
const W_DEPENDS_ON: StepKeyWitness = {
  file: ELIG,
  pattern: 'const deps = step.depends_on ?? [];',
  count: 3, // trigger-rule satisfaction, the skip-propagation pass, and the skip-cascade walk
};
const W_TRIGGER_RULE: StepKeyWitness = {
  file: ELIG,
  pattern: "const rule: TriggerRule = step.trigger_rule ?? 'all_success';",
  count: 2, // trigger-rule satisfaction and skip-propagation resolve it the same way
};
// Deliberately the Step-2a READ shape, never the checkPreconditions CALL text: the #369
// call-site walker (yaml-loader.test.ts) counts every non-test line carrying that call text —
// comments included, since it is line-based — so spelling the call itself here would register as
// a second call site and red that unrelated walker (witness-collision class, header above). This
// read shape is the same consumption evidence without the collision.
const W_PRECONDITIONS: StepKeyWitness = {
  file: EL,
  pattern: 'if (stepDef?.preconditions !== undefined && stepDef.preconditions.length > 0) {',
};
const W_GATE_MINT_TRUST: StepKeyWitness = {
  file: EL,
  pattern: "if (stepDef!.trust === 'human_confirmed' || stepDef!.trust === 'human_reviewed') {",
};
const W_GATE_CHOICES: StepKeyWitness = {
  file: EL,
  pattern: "stepDef!.gate?.choices ?? stepDef!.input_schema?.properties?.['choice']?.enum;",
};
const W_INPUT_SCHEMA_2B: StepKeyWitness = {
  file: EL,
  pattern: 'validateInputSchema(effectiveInput, stepDef.input_schema, options.command);',
};
const W_DESCRIPTION_GEN: StepKeyWitness = { file: GEN, pattern: 'description: step.description,' };
const W_TOOLS_PATH: StepKeyWitness = {
  file: RA,
  pattern: 'if (stepDef.tools && stepDef.tools.length > 0 && mcpClient) {',
};
const W_PROMPT_NEXTACTION: StepKeyWitness = {
  file: EL,
  pattern: 'step.prompt !== undefined ? renderTemplate(step.prompt, context) : undefined;',
};
const W_ADAPTER_DISPATCH: StepKeyWitness = {
  file: EL,
  pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
};
const W_SERVICE_METHOD_READ: StepKeyWitness = {
  file: EL,
  pattern: "const method = stepDef.service_method ?? 'fetch';",
};
const W_OPERATION_READ: StepKeyWitness = {
  file: EL,
  pattern: 'const operation = stepDef.operation ?? options.command;',
};
const W_INPUT_MAP_RESOLVE: StepKeyWitness = {
  file: EL,
  pattern: 'const adapterParams = resolveInputMap(stepDef.input_map, options, pendingRun);',
};
const W_HANDLER_AUTO_DISPATCH: StepKeyWitness = {
  file: EL,
  pattern: "} else if (stepDef?.execution === 'auto' && stepDef.handler !== undefined) {",
};
const W_OUTPUT_SCHEMA_READ: StepKeyWitness = {
  file: EL,
  pattern: "stepDef?.execution === 'agent' && stepDef.output_schema !== undefined",
};
const W_TRACE_SCHEMA_READ: StepKeyWitness = {
  file: EL,
  pattern: 'if (stepDef.trace_schema !== undefined) {',
};
const W_TRACE_MODE_READ: StepKeyWitness = {
  file: EL,
  pattern: "const mode = stepDef.trace_validation_mode ?? 'warn';",
};
const W_RETRY_READ: StepKeyWitness = { file: EL, pattern: 'const retryConfig = stepDef?.retry;' };
const W_VALIDATION_EXHAUSTION_READ: StepKeyWitness = {
  file: EL,
  pattern: 'stepDef.validation_exhaustion?.threshold ?? DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD;',
};
const W_STRUCTURED_OUTPUT_READ: StepKeyWitness = {
  file: EL,
  pattern: '...(stepDef?.structured_output !== undefined',
  count: 3, // the attempt disclosure is minted at all three seal shapes (census lane 2)
};
const W_TIMEOUT_ENFORCE: StepKeyWitness = {
  file: EL,
  pattern: 'const enforceTimeout = stepDef !== undefined && shouldEnforceTimeout(stepDef);',
};

/** #517 rung 2: file-shorthand → the operator phrase a consequence clause names it by. TOTAL over
 *  every file this registry cites as a witness (conformance-checked below — a missing entry is a
 *  red cell, not a silent fallback). Operator words, never file basenames (D7-5). */
export const SURFACE_NAME: Record<string, string> = {
  [EL]: "the engine's execution loop",
  [ELIG]: 'step eligibility',
  [SETTLE]: 'finalizer selection',
  [CL]: 'claim liveness',
  [YL]: 'the workflow loader',
  [RA]: "realm's own drive",
  [RECLAIM]: 'the reclaim command',
  [GEN]: 'the protocol briefing',
};

/** #517 rung 2: where a generic-prohibited key actually LIVES — the data behind the minted
 *  message's witness-backed consequence clause. `kinds` is asserted deep-equal to the DERIVED set
 *  of kinds whose cell is `consumed` (truth cell 1); `site` is REFERENCE-IDENTICAL to a member of
 *  one of this key's consumed cells' `where[]` (truth cell 2) — the message's factual citation IS
 *  the tested witness, one object; `mechanism` is asserted byte-contained in every minted generic
 *  message for the key (truth cell 3) and must CONTAIN `SURFACE_NAME[site.file]` (truth cell 4).
 *
 *  STATED RESIDUAL (the D4-4 honesty line): a wrong VERB in the mechanism prose is not
 *  machine-caught — the truth cells bind the surface named and the witness cited, not the
 *  grammar of what the surface DOES with the key. That last inch stays on review.
 *
 *  `remedy` is per-key judgment: a re-admission clause appears ONLY where a genuine widening is
 *  on the board (the three-clause doctrine — no boilerplate fourth clause). As of #517, no
 *  generic-prohibited key has an open widening issue, so no entry below carries one. */
export type ConsumedHome = {
  kinds: ExecutionMode[];
  mechanism: string;
  site: StepKeyWitness;
  remedy: string;
};
export const CONSUMED_HOME: Partial<Record<(typeof KNOWN_STEP_KEYS)[number], ConsumedHome>> = {
  depends_on: {
    kinds: ['auto', 'agent', 'guard'],
    mechanism:
      'step eligibility reads it to gate when a DAG step becomes runnable, and a finalizer is ' +
      "selected by 'on_outcome' at settlement, never through the DAG, so here it would order " +
      'nothing.',
    site: W_DEPENDS_ON,
    remedy: "Sequence the finalizer with 'on_outcome' instead, or remove it.",
  },
  trigger_rule: {
    kinds: ['auto', 'agent'],
    mechanism:
      'step eligibility reads it to decide how dependency outcomes gate a DAG step, and only ' +
      'auto/agent steps are gated that way, so here it would gate nothing.',
    site: W_TRIGGER_RULE,
    remedy: 'Move it to the auto or agent step it should gate, or remove it.',
  },
  when: {
    kinds: ['auto', 'agent', 'guard'],
    mechanism:
      'step eligibility evaluates it before a step may run, and a finalizer is selected by the ' +
      "run's outcome at settlement, never by eligibility, so here it would route nothing.",
    site: W_WHEN_ELIG,
    remedy: "Route the finalizer with 'on_outcome' instead, or remove it.",
  },
  uses_service: {
    kinds: ['auto'],
    mechanism:
      "the engine's execution loop routes a step's work through the named service adapter only " +
      'on the auto dispatch path, so here it would dispatch nothing.',
    site: W_ADAPTER_DISPATCH,
    remedy: 'Move it to an auto step, or remove it.',
  },
  service_method: {
    kinds: ['auto'],
    mechanism:
      "the engine's execution loop reads it to pick the adapter operation on the auto dispatch " +
      'path, so here it would pick nothing.',
    site: W_SERVICE_METHOD_READ,
    remedy: 'Move it to an auto step, or remove it.',
  },
  operation: {
    kinds: ['auto'],
    mechanism:
      "the engine's execution loop reads it as the adapter operation name on the auto dispatch " +
      'path, so here it would name nothing.',
    site: W_OPERATION_READ,
    remedy: 'Move it to an auto step, or remove it.',
  },
  input_map: {
    kinds: ['auto'],
    mechanism:
      "the engine's execution loop resolves it into dispatch parameters on the auto path, so " +
      'here it would map nothing.',
    site: W_INPUT_MAP_RESOLVE,
    remedy: 'Move it to an auto step, or remove it.',
  },
  handler: {
    kinds: ['auto', 'agent', 'finalizer'],
    mechanism:
      "the engine's execution loop dispatches work through it on auto, agent and finalizer " +
      "steps, and a guard's execution evaluates only 'abort_unless', so here it would run " +
      'nothing.',
    site: W_HANDLER_AUTO_DISPATCH,
    remedy: 'Move it to a step of a kind that dispatches it, or remove it.',
  },
  input_schema: {
    kinds: ['auto', 'agent'],
    mechanism:
      "the engine's execution loop validates a step's effective input against it at execution " +
      "time, and a guard's execution evaluates only 'abort_unless', so here it would validate " +
      'nothing.',
    site: W_INPUT_SCHEMA_2B,
    remedy: 'Move it to the auto or agent step whose input it should check, or remove it.',
  },
  output_schema: {
    kinds: ['agent'],
    mechanism:
      "the engine's execution loop validates an agent step's submitted output against it, and " +
      'only agent steps submit output that way, so here it would validate nothing.',
    site: W_OUTPUT_SCHEMA_READ,
    remedy: 'Move it to the agent step whose output it should check, or remove it.',
  },
  trace_schema: {
    kinds: ['agent'],
    mechanism:
      "the engine's execution loop validates an agent step's appended trace against it, and " +
      'only agent steps carry a validated trace, so here it would validate nothing.',
    site: W_TRACE_SCHEMA_READ,
    remedy: 'Move it to the agent step whose trace it should check, or remove it.',
  },
  trace_validation_mode: {
    kinds: ['agent'],
    mechanism:
      "the engine's execution loop reads it to choose warn-or-enforce for 'trace_schema' " +
      'validation, which only agent steps carry, so here it would choose nothing.',
    site: W_TRACE_MODE_READ,
    remedy: 'Move it to the agent step whose trace validation it should set, or remove it.',
  },
  trust: {
    kinds: ['auto', 'agent'],
    mechanism:
      "the engine's execution loop reads it to mint a human gate before the step runs, and a " +
      'guard is never gated that way, so here it would gate nothing.',
    site: W_GATE_MINT_TRUST,
    remedy: 'Move it to the auto or agent step that needs the gate, or remove it.',
  },
  timeout_seconds: {
    kinds: ['auto', 'finalizer'],
    mechanism:
      "the engine's execution loop enforces it as the time-bound on auto dispatch and on a " +
      "finalizer's drain, and a guard's evaluation is never time-bounded, so here it would " +
      'bound nothing.',
    site: W_TIMEOUT_ENFORCE,
    remedy: 'Move it to the auto or finalizer step it should bound, or remove it.',
  },
  retry: {
    kinds: ['auto'],
    mechanism:
      "the engine's execution loop reads it to re-attempt failed auto dispatch, and only auto " +
      'attempts are retried that way, so here it would retry nothing.',
    site: W_RETRY_READ,
    remedy: 'Move it to the auto step whose attempts it should govern, or remove it.',
  },
  validation_exhaustion: {
    kinds: ['agent'],
    mechanism:
      "the engine's execution loop counts an agent step's schema rejections against its " +
      'threshold, and only agent submissions are counted that way, so here it would count ' +
      'nothing.',
    site: W_VALIDATION_EXHAUSTION_READ,
    remedy: 'Move it to the agent step whose rejections it should bound, or remove it.',
  },
  tools: {
    kinds: ['agent'],
    mechanism:
      "in realm's own drive it is the tool list offered to the model on an agent step, and " +
      'only agent steps make model requests, so here it would offer nothing.',
    site: W_TOOLS_PATH,
    remedy: 'Move it to the agent step that should call the tools, or remove it.',
  },
  structured_output: {
    kinds: ['agent'],
    mechanism:
      "the engine's execution loop records an agent step's strict-output mode on its attempt " +
      'evidence, and only agent attempts carry it, so here it would constrain nothing.',
    site: W_STRUCTURED_OUTPUT_READ,
    remedy: 'Move it to the agent step whose output it should constrain, or remove it.',
  },
};

/** #517: the TRUE prohibited set per kind — every key whose cell on `mode` is `prohibited`
 *  WITHOUT an `except` arm (the except cell, today exactly trust×finalizer, keeps its
 *  value-conditional hand-written check and is deliberately absent). The loader's exported
 *  `GUARD_PROHIBITED_STEP_KEYS` / `FINALIZER_PROHIBITED_STEP_KEYS` are computed from this — one
 *  source, no membership drift possible. */
export function prohibitedKeysFor(mode: ExecutionMode): string[] {
  return (Object.keys(STEP_KEY_REGISTRY) as Array<keyof typeof STEP_KEY_REGISTRY>).filter((key) => {
    const cell: StepKeyCell = STEP_KEY_REGISTRY[key][mode];
    return cell.c === 'prohibited' && cell.except === undefined;
  });
}

/** #517: the kinds a key is actually CONSUMED on — the derived valid-kind set behind an
 *  'only_valid' front clause (and truth cell 1's comparator for consumed_home.kinds). */
export function consumedKindsFor(key: (typeof KNOWN_STEP_KEYS)[number]): ExecutionMode[] {
  const modes: ExecutionMode[] = ['auto', 'agent', 'guard', 'finalizer'];
  return modes.filter((mode) => STEP_KEY_REGISTRY[key][mode].c === 'consumed');
}

/**
 * Real program defects on a key×kind surface that cannot be expressed as a cell arm — the key
 * itself IS consumed (or the arm is otherwise fully accounted for); the defect lives in an
 * adjacent mechanism. Recorded here so the #417 program's fate-line contract covers them from
 * the registry itself, not just from the PR body. Via-hygiene-checked exactly like a tracked
 * citation inside a cell.
 */
export const TRACKED_RESIDUALS: Array<{ issue: `#${number}`; desc: string }> = [
  {
    issue: '#515',
    desc:
      'handler×finalizer: capability preflight excludes finalizer handlers entirely — an ' +
      'unregistered finalizer handler is caught only at drain time, as a pending-forever ' +
      'liveness gap. The key itself is consumed and required; the gap is in when the ' +
      'requirement gets checked.',
  },
  {
    issue: '#519',
    desc:
      'the whole-registry loader-bypass class: a WorkflowDefinition that reaches the engine ' +
      'without going through this loader (a store-injected definition) satisfies none of these ' +
      'prohibitions at all — a registry-driven runtime mirror at the engine boundary is its ' +
      'own, separate design arc.',
  },
];

export const STEP_KEY_REGISTRY = {
  description: {
    auto: {
      c: 'consumed',
      where: [
        { file: EL, pattern: "human_readable: `Execute step '${stepName}': ${step.description}`," },
      ],
    },
    agent: {
      c: 'consumed',
      where: [{ file: RA, pattern: 'const prompt = nextAction?.prompt ?? stepDef.description;' }],
    },
    guard: {
      c: 'consumed',
      where: [W_DESCRIPTION_GEN],
      when: {
        desc: 'disclosure-only: required on every kind, surfaced in the protocol briefing, but no engine-execution path ever reads it for a guard',
        witness: W_DESCRIPTION_GEN,
      },
    },
    finalizer: {
      c: 'consumed',
      where: [W_DESCRIPTION_GEN],
      when: {
        desc: 'disclosure-only, same as ×guard',
        witness: W_DESCRIPTION_GEN,
      },
    },
  },
  execution: {
    auto: {
      c: 'consumed',
      where: [W_ADAPTER_DISPATCH],
    },
    agent: {
      c: 'consumed',
      where: [{ file: EL, pattern: "definition.steps[name]?.execution === 'agent' ||" }],
    },
    guard: {
      c: 'consumed',
      where: [{ file: ELIG, pattern: "if (step.execution !== 'guard') continue;" }],
    },
    finalizer: {
      c: 'consumed',
      where: [{ file: SETTLE, pattern: "if (step.execution !== 'finalizer') continue;" }],
    },
  },
  depends_on: {
    auto: { c: 'consumed', where: [W_DEPENDS_ON] },
    agent: { c: 'consumed', where: [W_DEPENDS_ON] },
    guard: { c: 'consumed', where: [W_DEPENDS_ON] },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  trigger_rule: {
    auto: { c: 'consumed', where: [W_TRIGGER_RULE] },
    agent: { c: 'consumed', where: [W_TRIGGER_RULE] },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  when: {
    auto: { c: 'consumed', where: [W_WHEN_ELIG] },
    agent: { c: 'consumed', where: [W_WHEN_ELIG] },
    guard: {
      c: 'consumed',
      where: [W_WHEN_ELIG],
      when: {
        desc: "guard selection evaluates when before executeGuardStep ever runs — 'guards evaluate only abort_unless' is true of execution, false of eligibility (census lane-1 contradiction 2)",
        witness: {
          file: ELIG,
          pattern:
            'const evidenceByStep = buildEvidenceByStep(run); if (!evaluateWhen(step.when, evidenceByStep, run.params)) continue;',
        },
      },
    },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  abort_unless: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ABORT_UNLESS },
    agent: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ABORT_UNLESS },
    guard: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern:
            'const conditions = Array.isArray(stepDef.abort_unless) ? stepDef.abort_unless : [stepDef.abort_unless!];',
        },
      ],
    },
    finalizer: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_ABORT_UNLESS,
    },
  },
  abort_message: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ABORT_MESSAGE },
    agent: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_ABORT_MESSAGE,
    },
    guard: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern:
            '...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),',
          count: 2, // both guard-abort output branches carry the disclosure (census lane-1 correction)
        },
        {
          file: EL,
          pattern: "error: stepDef.abort_message ?? `Guard step '${stepName}' aborted the run.`,",
        },
      ],
    },
    finalizer: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_ABORT_MESSAGE,
    },
  },
  on_outcome: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ON_OUTCOME },
    agent: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ON_OUTCOME },
    guard: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_ON_OUTCOME },
    finalizer: {
      c: 'consumed',
      where: [{ file: SETTLE, pattern: 'const raw = stepDef.on_outcome;' }],
    },
  },
  idempotent: {
    auto: {
      c: 'consumed',
      where: [
        { file: EL, pattern: 'stepDef!.idempotent === true &&' },
        { file: RECLAIM, pattern: 'if (stepDef?.idempotent !== true) return false;' },
      ],
      inert_subpop: [
        {
          desc: 'on the auto step of a finalizer-bearing workflow: the reclaim half is inert (a claim with no deadline is never selected by reclaim --all); the retry.on_timeout gate half stays live',
          via: { kind: 'advisory', code: 'IDEMPOTENT_INERT_IN_FINALIZER' },
        },
      ],
    },
    agent: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_IDEMPOTENT },
    guard: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_IDEMPOTENT },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_IDEMPOTENT },
  },
  uses_service: {
    auto: {
      c: 'consumed',
      where: [W_ADAPTER_DISPATCH],
    },
    agent: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  service_method: {
    auto: {
      c: 'consumed',
      where: [W_SERVICE_METHOD_READ],
      when: {
        desc: 'dispatch-arm-keyed: read only on the uses_service adapter dispatch path',
        witness: W_ADAPTER_DISPATCH,
      },
      inert_subpop: [
        {
          desc: 'declared without uses_service: the adapter dispatch path never runs, so this is never read',
          via: {
            kind: 'waived',
            reason:
              'a dispatch-arm companion field, meaningful only beside uses_service — the dead-config policing call for the whole dispatch family is #511 territory and undecided',
          },
        },
      ],
    },
    agent: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  operation: {
    auto: {
      c: 'consumed',
      where: [W_OPERATION_READ],
      when: {
        desc: 'dispatch-arm-keyed: read only on the uses_service adapter dispatch path',
        witness: W_ADAPTER_DISPATCH,
      },
      inert_subpop: [
        {
          desc: 'declared without uses_service: never read',
          via: {
            kind: 'waived',
            reason:
              'dispatch-arm companion, same family as service_method — #511 territory and undecided',
          },
        },
      ],
    },
    agent: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  input_map: {
    auto: {
      c: 'consumed',
      where: [W_INPUT_MAP_RESOLVE],
      when: {
        desc: 'dispatch-arm-keyed: resolved on the adapter path, and delivered to handlers via the resolved params',
        witness: W_ADAPTER_DISPATCH,
      },
      inert_subpop: [
        {
          desc: 'declared with neither uses_service nor handler: a bare auto step dispatches nothing, so nothing consumes it',
          via: {
            kind: 'waived',
            reason: 'dispatch-arm companion, same family call as service_method/operation',
          },
        },
      ],
    },
    agent: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  handler: {
    auto: {
      c: 'consumed',
      where: [W_HANDLER_AUTO_DISPATCH],
      inert_subpop: [
        {
          desc: 'shadowed when uses_service is also declared: dispatch precedence tries the adapter arm first, and no both-declared check exists to flag it',
          via: { kind: 'tracked', issue: '#511' },
        },
      ],
    },
    agent: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: 'step.handler !== undefined ? { tool: step.handler, params: {}, call_with: {} }',
        },
      ],
      when: {
        desc: 'handler-bearing agent step: the NextAction names the handler as the tool to call, and this arm OUTRANKS the plain execute_step instruction — semantics are under #516, but the read itself is real (D4-2)',
        witness: {
          file: EL,
          pattern: 'step.handler !== undefined ? { tool: step.handler, params: {}, call_with: {} }',
        },
      },
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: {
      c: 'consumed',
      where: [{ file: EL, pattern: 'const handlerName = stepDef?.handler;' }],
      when: {
        desc: 'REQUIRED (handler-only in v1) — drained via callHandler, never through executeStep',
        witness: { file: EL, pattern: 'const handlerName = stepDef?.handler;' },
      },
    },
  },
  config: {
    auto: {
      c: 'consumed',
      where: [{ file: EL, pattern: '...(stepDef.config ?? {}),' }],
      inert_subpop: [
        {
          desc: 'declared with neither uses_service nor handler: never delivered to anything',
          via: {
            kind: 'waived',
            reason:
              'dispatch-arm companion, same family call as service_method/operation/input_map',
          },
        },
      ],
    },
    agent: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    finalizer: {
      c: 'consumed',
      where: [{ file: EL, pattern: 'config: stepDef.config ?? {},' }],
      when: {
        desc: 'delivered to the finalizer handler via callHandler context — genuinely consumed on this kind, deliberately NOT part of the #511 dispatch-family tracking (census lane 2)',
        witness: { file: EL, pattern: 'config: stepDef.config ?? {},' },
      },
    },
  },
  input_schema: {
    auto: {
      c: 'consumed',
      where: [W_INPUT_SCHEMA_2B],
      when: {
        desc: 'Step 2b validates the effective input against it with no kind conjunct at all; also the gate-choice fallback source on gate-trusted steps',
        witness: W_INPUT_SCHEMA_2B,
      },
    },
    agent: { c: 'consumed', where: [W_INPUT_SCHEMA_2B] },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#512' } },
  },
  output_schema: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_OUTPUT_SCHEMA_READ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  trace_schema: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_TRACE_SCHEMA_READ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
  },
  trace_validation_mode: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_TRACE_MODE_READ],
      inert_subpop: [
        {
          desc: 'declared without trace_schema: the only read sits inside the trace_schema branch and is never reached — silently ignored, with no dead-config advisory today despite two in-file precedents for that shape',
          via: { kind: 'tracked', issue: '#514' },
        },
      ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
  },
  preconditions: {
    auto: { c: 'consumed', where: [W_PRECONDITIONS] },
    agent: { c: 'consumed', where: [W_PRECONDITIONS] },
    guard: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_PRECONDITIONS_GUARD,
    },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#509' } },
  },
  trust: {
    auto: {
      c: 'consumed',
      where: [W_GATE_MINT_TRUST],
      inert_subpop: [
        {
          desc: "unrecognized literals load clean — there is no step-level trust VALUE validation at all — and silently UN-GATE the step, since the gate mint matches only the two literals 'human_confirmed'/'human_reviewed'",
          via: { kind: 'tracked', issue: '#508' },
        },
      ],
    },
    agent: {
      c: 'consumed',
      where: [W_GATE_MINT_TRUST],
      inert_subpop: [
        {
          desc: 'unrecognized literals load clean and silently un-gate, the same hole as ×auto',
          via: { kind: 'tracked', issue: '#508' },
        },
      ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: {
      c: 'prohibited',
      by: [BY_TRUST_FINALIZER],
      line: 'step',
      except: {
        desc: "the literal 'auto' is accepted and unread on a finalizer — redundant, harmless (D4-1)",
        via: {
          kind: 'waived',
          reason:
            "'auto' is the only lawful trust literal on a finalizer, so refusing it would refuse a truthful no-op declaration",
        },
      },
    },
  },
  timeout_seconds: {
    auto: {
      c: 'consumed',
      where: [
        W_TIMEOUT_ENFORCE,
        {
          file: CL,
          pattern:
            'const perAttemptSec = step.timeout_seconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS;',
        },
      ],
      when: {
        desc: "shouldEnforceTimeout is the auto-only predicate — the reason #402's prohibition on agent steps is a hard 'not valid', while the same key stays consumed on finalizers (drain + lease, below)",
        witness: { file: CL, pattern: "return step.execution === 'auto';" },
      },
    },
    agent: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_TIMEOUT_ON_AGENT,
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: 'const timeoutMs = (step.timeout_seconds ?? DRAIN_CEILING_SECONDS) * 1000;',
        },
        {
          file: EL,
          pattern: 'const leaseSeconds = stepDef.timeout_seconds ?? DRAIN_CEILING_SECONDS;',
        },
      ],
    },
  },
  retry: {
    auto: {
      c: 'consumed',
      where: [W_RETRY_READ],
    },
    agent: { c: 'inert', via: { kind: 'advisory', code: 'RETRY_INERT_NON_AUTO' } },
    guard: { c: 'inert', via: { kind: 'advisory', code: 'RETRY_INERT_NON_AUTO' } },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  validation_exhaustion: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_VALIDATION_EXHAUSTION_READ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
  },
  instructions: {
    auto: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: 'stepDef!.instructions !== undefined ? renderTemplate(stepDef!.instructions, {',
        },
      ],
      when: {
        desc: 'gate-path: rendered into the gate envelope for gated autos; the same value is also protocol-surfaced for every step regardless of kind',
        witness: W_GATE_MINT_TRUST,
      },
    },
    agent: {
      c: 'consumed',
      where: [{ file: GEN, pattern: 'protocolStep.instructions = step.instructions;' }],
      when: {
        desc: "disclosure-only in realm's own drive — run-agent builds the model task from prompt ?? description and never feeds instructions to the model at all (a cross-drive asymmetry vs. an external MCP agent, which does see it; census lane-1 contradiction 4)",
        witness: { file: GEN, pattern: 'protocolStep.instructions = step.instructions;' },
      },
    },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
  },
  prompt: {
    auto: {
      c: 'consumed',
      where: [W_PROMPT_NEXTACTION],
      when: {
        desc: 'handler-bearing or gated autos only — a gateless, handler-less auto never reads it',
        witness: W_PROMPT_NEXTACTION,
      },
      inert_subpop: [
        {
          desc: 'gateless, handler-less auto: never read anywhere',
          via: {
            kind: 'waived',
            reason:
              'this sub-population is exactly the complement of the two documented read paths — surface-conditional by design',
          },
        },
      ],
    },
    agent: { c: 'consumed', where: [W_PROMPT_NEXTACTION] },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
  },
  display: {
    auto: {
      c: 'consumed',
      where: [
        {
          file: RA,
          pattern:
            '(gateStepDef?.display !== undefined ? renderDisplay(gateStepDef.display, gate.preview)',
        },
      ],
      when: {
        desc: "gate-trusted only — rendered on the gate surface; the run-completion result render is agent-only (see this PR's JSDoc truth fix on StepDefinition.display)",
        witness: {
          file: RA,
          pattern:
            '(gateStepDef?.display !== undefined ? renderDisplay(gateStepDef.display, gate.preview)',
        },
      },
      inert_subpop: [
        {
          desc: 'gateless auto: never read by anything',
          via: {
            kind: 'waived',
            reason:
              'documented-inert after the JSDoc truth fix — the type doc no longer promises run-completion rendering for a non-agent step (D4-3)',
          },
        },
      ],
    },
    agent: {
      c: 'consumed',
      where: [
        {
          file: RA,
          pattern:
            'stepDef?.display !== undefined ? renderDisplay(stepDef.display, lastAgentEvidence.output_summary)',
        },
      ],
    },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#513' } },
  },
  use_template: {
    auto: {
      c: 'na',
      reason:
        'resolved away before any step validation runs: the template resolver REPLACES the entry entirely, so it is never present in a WorkflowDefinition returned to any caller (census lane 1)',
    },
    agent: { c: 'na', reason: 'resolved away pre-validation (see ×auto)' },
    guard: { c: 'na', reason: 'resolved away pre-validation (see ×auto)' },
    finalizer: { c: 'na', reason: 'resolved away pre-validation (see ×auto)' },
  },
  gate: {
    auto: {
      c: 'consumed',
      where: [W_GATE_CHOICES],
      when: {
        desc: 'gate-trusted only: the mint reads the gate config exactly once — every later enactment read sees only the already-FROZEN PendingGate',
        witness: W_GATE_MINT_TRUST,
      },
      inert_subpop: [
        {
          desc: 'without gate trust: fully validated at load time (#291/#433) and never minted',
          via: {
            kind: 'waived',
            reason:
              "in-code-admitted posture — the #291 block's own header comment documents that a gate: block with no gate trust is inert and is deliberately validated anyway",
          },
        },
      ],
    },
    agent: {
      c: 'consumed',
      where: [W_GATE_CHOICES],
      when: {
        desc: 'gate-trusted only, the same mint site',
        witness: W_GATE_MINT_TRUST,
      },
      inert_subpop: [
        {
          desc: 'without gate trust: validated, never minted',
          via: { kind: 'waived', reason: 'in-code-admitted posture, see ×auto' },
        },
      ],
    },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#512' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#512' } },
  },
  agent_profile: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_AGENT_PROFILE },
    agent: {
      c: 'consumed',
      where: [
        { file: EL, pattern: 'const profile = stepDef?.agent_profile;' },
        {
          file: RA,
          pattern:
            'stepDef.agent_profile !== undefined ? definition.resolved_profiles?.[stepDef.agent_profile]?.content : undefined;',
        },
      ],
    },
    guard: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_AGENT_PROFILE,
    },
    finalizer: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_AGENT_PROFILE,
    },
  },
  tools: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_TOOLS_PATH],
      inert_subpop: [
        {
          desc: 'tools: [] is treated as toolless — it loads with zero tools diagnostics, is runtime-toolless, and in turn inerts the tool-budget keys below',
          via: { kind: 'tracked', issue: '#510' },
        },
      ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'not_valid' },
  },
  max_tool_calls: {
    auto: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
    agent: {
      c: 'consumed',
      where: [{ file: RA, pattern: 'maxToolCalls: stepDef.max_tool_calls ?? 20,' }],
      when: { desc: 'tools-path only', witness: W_TOOLS_PATH },
      inert_subpop: [
        {
          desc: 'tools-less agent step: consumption sits behind the tools-path gate — a bound with nothing to bind',
          via: { kind: 'tracked', issue: '#510' },
        },
      ],
    },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
  },
  max_fan_out: {
    auto: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
    agent: {
      c: 'consumed',
      where: [{ file: RA, pattern: 'const maxFanOut = stepDef.max_fan_out;' }],
      when: { desc: 'tools-path only', witness: W_TOOLS_PATH },
      inert_subpop: [
        {
          desc: 'tools-less agent step: never read',
          via: { kind: 'tracked', issue: '#510' },
        },
      ],
    },
    guard: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#510' } },
  },
  tool_timeout: {
    auto: {
      c: 'blocked_transitive',
      via: 'tools',
      by: [BY_TOOL_TIMEOUT],
      message_data: MSG_TOOL_TIMEOUT,
    },
    agent: {
      c: 'consumed',
      where: [{ file: RA, pattern: 'toolTimeoutMs: (stepDef.tool_timeout ?? 30) * 1000,' }],
      when: { desc: 'non-empty tools declared', witness: W_TOOLS_PATH },
    },
    guard: {
      c: 'blocked_transitive',
      via: 'tools',
      by: [BY_TOOL_TIMEOUT],
      message_data: MSG_TOOL_TIMEOUT,
    },
    finalizer: {
      c: 'blocked_transitive',
      via: 'tools',
      by: [BY_TOOL_TIMEOUT],
      message_data: MSG_TOOL_TIMEOUT,
    },
  },
  structured_output: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    agent: {
      c: 'consumed',
      where: [W_STRUCTURED_OUTPUT_READ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
    finalizer: { c: 'prohibited', by: [MINT], line: 'key', front: 'only_valid' },
  },
  llm_timeout_seconds: {
    auto: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_LLM_TIMEOUT },
    agent: {
      c: 'consumed',
      where: [
        {
          file: RA,
          pattern: '(stepDef.llm_timeout_seconds ?? fallbackLlmTimeoutSeconds) * 1000,',
        },
      ],
    },
    guard: { c: 'prohibited', by: [MINT], line: 'key', message_data: MSG_LLM_TIMEOUT },
    finalizer: {
      c: 'prohibited',
      by: [MINT],
      line: 'key',
      message_data: MSG_LLM_TIMEOUT,
    },
  },
} satisfies Record<(typeof KNOWN_STEP_KEYS)[number], Record<ExecutionMode, StepKeyCell>>;
