// step-key-registry.ts — issue #417 PR-2: the step-key consumption registry.
//
// Every member of KNOWN_STEP_KEYS crossed with every ExecutionMode (36 × 4 = 144 cells) is
// classified here with evidence: where the engine actually reads it, where the loader refuses
// it, and — where it is accepted but does nothing — WHY that silence is not actually silent (an
// advisory code, a written waiver, or an issue tracking a real defect). The `satisfies` clause at
// the bottom of this file turns a missing key or a missing kind into a COMPILE error: a new step
// key cannot ship without a row here.
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
//   4. Loop membership is witnessed by VALUE, not by source text: the two kind-prohibition lists
//      in yaml-loader.ts are exported consts (`GUARD_PROHIBITED_STEP_KEYS`,
//      `FINALIZER_PROHIBITED_STEP_KEYS`); a cell whose `by` carries the loop's own error-template
//      pattern is asserted a member of the matching exported array, in both directions.
//
// THE WITNESS-COLLISION CLASS: a witness is code-shaped text, which means it is visible to every
// OTHER line-based source-text guard in this suite too (the #369 preconditions call-site walker,
// which counts comment lines as well as code — it has redded twice against a careless witness
// spelling during this arc). The fix is never to weaken an existing guard; it is to respell THIS
// file's witness to avoid the trigger string (e.g. quoting the Step-2a READ shape rather than the
// call text a walker is specifically counting). A collision always manifests as an EXISTING
// unrelated cell going red while this file's own tests are green.
//
// MESSAGE_DATA (future-proofing for #517, the eventual drive-flip): where a prohibition mints one
// of the bespoke four-clause messages, the INVARIANT TAIL of that message — every byte after the
// shared `Step '<name>': ` prefix, before any positional `(line N)`/`(step at line N)` suffix — is
// recorded here verbatim and asserted byte-CONTAINED (never byte-equal; the step name and the
// line cite both interpolate) in the loader's real output by this PR's own behavioral cell. This
// also rides the `blocked_transitive` arm for the #413 tool_timeout texts, asserted on leg A only
// — a drift lock, nothing more: #517 will never MINT a companion-rule message from this data,
// since companion rules stay hand-written (the D3 amendment's reasoning). Where one loader
// message serves more than one kind (a shared const), every cell minting it points at the SAME
// string, so a corruption of that text reds every sharer at once — by design, not an accident.
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

// The two kind-prohibition loops' own error-template strings, each appearing exactly once in
// yaml-loader.ts (the `${field}` placeholder is what makes this a LOOP member, as opposed to a
// per-key rule that happens to render a similarly-shaped sentence, e.g. trust×finalizer's
// value-scoped check below). A `prohibited` cell whose `by` carries one of these two patterns is
// asserted, by the core runner, to be exactly the membership of the matching exported array.
export const FINALIZER_LOOP_PATTERN =
  "`Step '${stepName}': '${field}' is not valid on execution: finalizer steps`,";
export const GUARD_LOOP_PATTERN =
  "`Step '${stepName}': '${field}' is not valid on execution: guard steps`,";
const FIN_LOOP: StepKeyWitness = { file: YL, pattern: FINALIZER_LOOP_PATTERN };
const GUARD_LOOP: StepKeyWitness = { file: YL, pattern: GUARD_LOOP_PATTERN };

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

// ——— shared by-witnesses: the FIRING CONDITION of a per-key loader rule, never the message text
// itself (the message is asserted behaviorally, via message_data, wherever it is bespoke) ———
const BY_ON_OUTCOME: StepKeyWitness = {
  file: YL,
  pattern: "if (step['on_outcome'] !== undefined && step['execution'] !== 'finalizer') {",
};
const BY_ABORT_UNLESS: StepKeyWitness = {
  file: YL,
  pattern: "if (step['abort_unless'] !== undefined && step['execution'] !== 'guard') {",
};
const BY_ABORT_MESSAGE: StepKeyWitness = {
  file: YL,
  pattern: "if (step['abort_message'] !== undefined && step['execution'] !== 'guard') {",
};
const BY_AGENT_PROFILE: StepKeyWitness = {
  file: YL,
  pattern: "if ('agent_profile' in step && step['execution'] !== 'agent') {",
};
const BY_LLM_TIMEOUT: StepKeyWitness = {
  file: YL,
  pattern: "if (step['llm_timeout_seconds'] !== undefined && step['execution'] !== 'agent') {",
};
const BY_IDEMPOTENT: StepKeyWitness = {
  file: YL,
  pattern: "if (step['idempotent'] !== undefined && step['execution'] !== 'auto') {",
};
const BY_INPUT_MAP: StepKeyWitness = {
  file: YL,
  pattern: "`Step '${stepName}': 'input_map' is only valid on execution: auto steps`,",
};
const BY_OUTPUT_SCHEMA: StepKeyWitness = {
  file: YL,
  pattern: "if (step['output_schema'] !== undefined && step['execution'] !== 'agent') {",
};
const BY_TRACE_SCHEMA: StepKeyWitness = {
  file: YL,
  pattern: "if (step['trace_schema'] !== undefined && step['execution'] !== 'agent') {",
};
const BY_TRACE_MODE: StepKeyWitness = {
  file: YL,
  pattern: "if (step['trace_validation_mode'] !== undefined && step['execution'] !== 'agent') {",
};
const BY_VALIDATION_EXHAUSTION: StepKeyWitness = {
  file: YL,
  pattern: "`Step '${stepName}': 'validation_exhaustion' is only valid on execution: agent steps`,",
};
const BY_STRUCTURED_OUTPUT: StepKeyWitness = {
  file: YL,
  pattern: "`Step '${stepName}': 'structured_output' is only valid on execution: agent steps`,",
};
const BY_TOOLS: StepKeyWitness = {
  file: YL,
  pattern:
    "`Step '${stepName}': 'tools' is only valid on execution: agent steps without 'handler' defined`,",
};
const BY_TOOL_TIMEOUT: StepKeyWitness = {
  file: YL,
  pattern: "if (step['tool_timeout'] !== undefined && toolsMissing) {",
};
const BY_TIMEOUT_ON_AGENT: StepKeyWitness = {
  file: YL,
  pattern: "if (step['timeout_seconds'] !== undefined && step['execution'] === 'agent') {",
};
const BY_PRECONDITIONS_GUARD: StepKeyWitness = {
  file: YL,
  pattern:
    "if (step['preconditions'] !== undefined) { errors.push( withKeyLine( stepName, 'preconditions',",
};
const BY_TRUST_FINALIZER: StepKeyWitness = {
  file: YL,
  pattern: "if (step['trust'] !== undefined && step['trust'] !== 'auto') {",
};

// ——— recurring consumed witnesses (shared across more than one cell) ———
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
      where: [
        {
          file: EL,
          pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
        },
      ],
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
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  trigger_rule: {
    auto: { c: 'consumed', where: [W_TRIGGER_RULE] },
    agent: { c: 'consumed', where: [W_TRIGGER_RULE] },
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
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
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  abort_unless: {
    auto: { c: 'prohibited', by: [BY_ABORT_UNLESS], line: 'key', message_data: MSG_ABORT_UNLESS },
    agent: { c: 'prohibited', by: [BY_ABORT_UNLESS], line: 'key', message_data: MSG_ABORT_UNLESS },
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
      by: [FIN_LOOP, BY_ABORT_UNLESS], // multi-fire ×2 — both the loop and the dedicated check name it (census lane 1)
      line: 'key',
      message_data: MSG_ABORT_UNLESS,
    },
  },
  abort_message: {
    auto: { c: 'prohibited', by: [BY_ABORT_MESSAGE], line: 'key', message_data: MSG_ABORT_MESSAGE },
    agent: {
      c: 'prohibited',
      by: [BY_ABORT_MESSAGE],
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
      by: [FIN_LOOP, BY_ABORT_MESSAGE],
      line: 'key',
      message_data: MSG_ABORT_MESSAGE,
    },
  },
  on_outcome: {
    auto: { c: 'prohibited', by: [BY_ON_OUTCOME], line: 'key', message_data: MSG_ON_OUTCOME },
    agent: { c: 'prohibited', by: [BY_ON_OUTCOME], line: 'key', message_data: MSG_ON_OUTCOME },
    guard: { c: 'prohibited', by: [BY_ON_OUTCOME], line: 'key', message_data: MSG_ON_OUTCOME },
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
    agent: { c: 'prohibited', by: [BY_IDEMPOTENT], line: 'key', message_data: MSG_IDEMPOTENT },
    guard: { c: 'prohibited', by: [BY_IDEMPOTENT], line: 'key', message_data: MSG_IDEMPOTENT },
    finalizer: { c: 'prohibited', by: [BY_IDEMPOTENT], line: 'key', message_data: MSG_IDEMPOTENT },
  },
  uses_service: {
    auto: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
        },
      ],
    },
    agent: { c: 'inert', via: { kind: 'tracked', issue: '#511' } },
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  service_method: {
    auto: {
      c: 'consumed',
      where: [{ file: EL, pattern: "const method = stepDef.service_method ?? 'fetch';" }],
      when: {
        desc: 'dispatch-arm-keyed: read only on the uses_service adapter dispatch path',
        witness: {
          file: EL,
          pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
        },
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
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  operation: {
    auto: {
      c: 'consumed',
      where: [{ file: EL, pattern: 'const operation = stepDef.operation ?? options.command;' }],
      when: {
        desc: 'dispatch-arm-keyed: read only on the uses_service adapter dispatch path',
        witness: {
          file: EL,
          pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
        },
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
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  input_map: {
    auto: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: 'const adapterParams = resolveInputMap(stepDef.input_map, options, pendingRun);',
        },
      ],
      when: {
        desc: 'dispatch-arm-keyed: resolved on the adapter path, and delivered to handlers via the resolved params',
        witness: {
          file: EL,
          pattern: "if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {",
        },
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
    agent: { c: 'prohibited', by: [BY_INPUT_MAP], line: 'step' },
    guard: { c: 'prohibited', by: [GUARD_LOOP, BY_INPUT_MAP], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP, BY_INPUT_MAP], line: 'step' },
  },
  handler: {
    auto: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: "} else if (stepDef?.execution === 'auto' && stepDef.handler !== undefined) {",
        },
      ],
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
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
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
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
    finalizer: { c: 'inert', via: { kind: 'tracked', issue: '#512' } },
  },
  output_schema: {
    auto: { c: 'prohibited', by: [BY_OUTPUT_SCHEMA], line: 'step' },
    agent: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: "stepDef?.execution === 'agent' && stepDef.output_schema !== undefined",
        },
      ],
    },
    guard: { c: 'prohibited', by: [GUARD_LOOP, BY_OUTPUT_SCHEMA], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP, BY_OUTPUT_SCHEMA], line: 'step' },
  },
  trace_schema: {
    auto: { c: 'prohibited', by: [BY_TRACE_SCHEMA], line: 'step' },
    agent: {
      c: 'consumed',
      where: [{ file: EL, pattern: 'if (stepDef.trace_schema !== undefined) {' }],
    },
    guard: { c: 'prohibited', by: [BY_TRACE_SCHEMA], line: 'step' },
    finalizer: { c: 'prohibited', by: [BY_TRACE_SCHEMA], line: 'step' },
  },
  trace_validation_mode: {
    auto: { c: 'prohibited', by: [BY_TRACE_MODE], line: 'step' },
    agent: {
      c: 'consumed',
      where: [{ file: EL, pattern: "const mode = stepDef.trace_validation_mode ?? 'warn';" }],
      inert_subpop: [
        {
          desc: 'declared without trace_schema: the only read sits inside the trace_schema branch and is never reached — silently ignored, with no dead-config advisory today despite two in-file precedents for that shape',
          via: { kind: 'tracked', issue: '#514' },
        },
      ],
    },
    guard: { c: 'prohibited', by: [BY_TRACE_MODE], line: 'step' },
    finalizer: { c: 'prohibited', by: [BY_TRACE_MODE], line: 'step' },
  },
  preconditions: {
    auto: { c: 'consumed', where: [W_PRECONDITIONS] },
    agent: { c: 'consumed', where: [W_PRECONDITIONS] },
    guard: {
      c: 'prohibited',
      by: [BY_PRECONDITIONS_GUARD],
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
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
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
        {
          file: EL,
          pattern: 'const enforceTimeout = stepDef !== undefined && shouldEnforceTimeout(stepDef);',
        },
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
      by: [BY_TIMEOUT_ON_AGENT],
      line: 'key',
      message_data: MSG_TIMEOUT_ON_AGENT,
    },
    guard: { c: 'prohibited', by: [GUARD_LOOP], line: 'step' },
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
      where: [{ file: EL, pattern: 'const retryConfig = stepDef?.retry;' }],
    },
    agent: { c: 'inert', via: { kind: 'advisory', code: 'RETRY_INERT_NON_AUTO' } },
    guard: { c: 'inert', via: { kind: 'advisory', code: 'RETRY_INERT_NON_AUTO' } },
    finalizer: { c: 'prohibited', by: [FIN_LOOP], line: 'step' },
  },
  validation_exhaustion: {
    auto: { c: 'prohibited', by: [BY_VALIDATION_EXHAUSTION], line: 'step' },
    agent: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern:
            'stepDef.validation_exhaustion?.threshold ?? DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD;',
        },
      ],
    },
    guard: { c: 'prohibited', by: [BY_VALIDATION_EXHAUSTION], line: 'step' },
    finalizer: { c: 'prohibited', by: [BY_VALIDATION_EXHAUSTION], line: 'step' },
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
    auto: { c: 'prohibited', by: [BY_AGENT_PROFILE], line: 'key', message_data: MSG_AGENT_PROFILE },
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
      by: [GUARD_LOOP, BY_AGENT_PROFILE], // multi-fire ×2 (census lane 3)
      line: 'key',
      message_data: MSG_AGENT_PROFILE,
    },
    finalizer: {
      c: 'prohibited',
      by: [FIN_LOOP, BY_AGENT_PROFILE], // multi-fire ×2 (census lane 3)
      line: 'key',
      message_data: MSG_AGENT_PROFILE,
    },
  },
  tools: {
    auto: { c: 'prohibited', by: [BY_TOOLS], line: 'step' },
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
    guard: { c: 'prohibited', by: [GUARD_LOOP, BY_TOOLS], line: 'step' },
    finalizer: { c: 'prohibited', by: [FIN_LOOP, BY_TOOLS], line: 'step' },
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
    auto: { c: 'prohibited', by: [BY_STRUCTURED_OUTPUT], line: 'step' },
    agent: {
      c: 'consumed',
      where: [
        {
          file: EL,
          pattern: '...(stepDef?.structured_output !== undefined',
          count: 3, // the attempt disclosure is minted at all three seal shapes (census lane 2)
        },
      ],
    },
    guard: { c: 'prohibited', by: [BY_STRUCTURED_OUTPUT], line: 'step' },
    finalizer: { c: 'prohibited', by: [BY_STRUCTURED_OUTPUT], line: 'step' },
  },
  llm_timeout_seconds: {
    auto: { c: 'prohibited', by: [BY_LLM_TIMEOUT], line: 'key', message_data: MSG_LLM_TIMEOUT },
    agent: {
      c: 'consumed',
      where: [
        {
          file: RA,
          pattern: '(stepDef.llm_timeout_seconds ?? fallbackLlmTimeoutSeconds) * 1000,',
        },
      ],
    },
    guard: { c: 'prohibited', by: [BY_LLM_TIMEOUT], line: 'key', message_data: MSG_LLM_TIMEOUT },
    finalizer: {
      c: 'prohibited',
      by: [BY_LLM_TIMEOUT],
      line: 'key',
      message_data: MSG_LLM_TIMEOUT,
    },
  },
} satisfies Record<(typeof KNOWN_STEP_KEYS)[number], Record<ExecutionMode, StepKeyCell>>;
