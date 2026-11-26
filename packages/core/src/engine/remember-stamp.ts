// remember-stamp.ts — gap 3, unit 1a: what a step with `remember:` records on the entry it writes
// when it settles successfully.
//
// One pure, total function for every door. The execution loop calls it at its one successful settle
// (`outcome: 'complete'`) and its one gate answer (`settle_gate`), before the store's write, so the
// stamp rides the new entry in that same write and is in the reply too. A store never stamps: its
// settle-step contract appends evidence verbatim. A defect in the block or its paths becomes a
// `not_remembered` reason, or no stamp; it never fails, delays or blocks the step's own write.
import type {
  EvidenceSnapshot,
  NotRemembered,
  NotRememberedReason,
  RememberedStamp,
  RunRecord,
} from '../types/run-record.js';
import type {
  InputMapNode,
  RememberConfig,
  WorkflowDefinition,
} from '../types/workflow-definition.js';
import { markersIn } from '../utils/redaction.js';
import { isRememberBlock } from '../workflow/remember-block.js';
import { resolveInputMap } from './input-map.js';

/** The most a remembered value may hold, as JSON in UTF-8 bytes; recall's cap reuses it (unit 3). */
export const REMEMBER_VALUE_MAX_BYTES = 32_768;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The reply's warning (Words 9), per reason. */
const NOT_REMEMBERED_WORDS: Readonly<Record<NotRememberedReason, (name: string) => string>> = {
  settled_by_default: () => 'it took its default answer',
  paths_unreadable: () => 'its paths could not be read',
  key_absent: (name) => `its key '${name}' was not there`,
  key_null: (name) => `its key '${name}' was null`,
  key_empty: (name) => `its key '${name}' was empty`,
  key_not_text: (name) => `its key '${name}' was not text or a number`,
  key_masked: (name) => `its key '${name}' was a masked value`,
  value_too_large: () => 'what it would remember was over 32 KB',
};

/** The warning a `not_remembered` stamp adds to the reply of the write that applied it. */
export function notRememberedWarning(stepName: string, stamp: NotRemembered): string {
  const reason = NOT_REMEMBERED_WORDS[stamp.not_remembered](stamp.key_name ?? '');
  return `Step '${stepName}' remembered nothing in '${stamp.as}': ${reason}.`;
}

/** A key part as its text, or why it cannot be one. */
function keyPartOf(value: unknown): { text: string } | { reason: NotRememberedReason } {
  if (value === undefined) return { reason: 'key_absent' };
  if (value === null) return { reason: 'key_null' };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { text: String(value) } : { reason: 'key_not_text' };
  }
  if (typeof value !== 'string') return { reason: 'key_not_text' };
  if (value.trim() === '') return { reason: 'key_empty' };
  if (markersIn(value).length > 0) return { reason: 'key_masked' };
  return { text: value };
}

/** Whether a resolved leaf is something JSON can hold: an absent value or a function is left out. */
function holdable(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function';
}

/** The declared value as resolved, each leaf that resolved to nothing JSON can hold left out. */
function keptValue(
  map: Record<string, InputMapNode>,
  resolved: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(map)) {
    const value = resolved[name];
    const nested =
      typeof node === 'object' && node !== null && !('$literal' in node) && !Array.isArray(node);
    if (nested && typeof value === 'object' && value !== null) {
      kept[name] = keptValue(
        node as Record<string, InputMapNode>,
        value as Record<string, unknown>,
      );
    } else if (holdable(value)) {
      kept[name] = value;
    }
  }
  return kept;
}

/** Whether the step's own entry was settled by its default: a gate answer judges the entry its
 *  question opened on (the step's last entry before the answer that is not a `gate_response`). */
function settledByDefault(entry: EvidenceSnapshot, run: RunRecord): boolean {
  if (entry.kind !== 'gate_response') return entry.diagnostics?.settled_by_default === true;
  for (let i = run.evidence.length - 1; i >= 0; i -= 1) {
    const prior = run.evidence[i]!;
    if (prior.step_id !== entry.step_id || prior.kind === 'gate_response') continue;
    return prior.diagnostics?.settled_by_default === true;
  }
  return false;
}

/**
 * What `entry` remembers under `block`, read against `run` (the record with the entry appended);
 * `undefined` for a block the schema refuses or an entry with no readable time. Checked in order:
 * settled by its default, a path throws, each key part as written, the value's size.
 */
export function rememberedStampOf(
  block: RememberConfig,
  entry: EvidenceSnapshot,
  run: RunRecord,
  defaulted: boolean,
): RememberedStamp | undefined {
  if (!isRememberBlock(block)) return undefined;
  const { as } = block;
  if (defaulted) return { as, not_remembered: 'settled_by_default' };
  let key: Record<string, unknown>;
  let value: Record<string, unknown> | undefined;
  try {
    key = resolveInputMap(block.key, {}, run);
    value =
      block.value !== undefined
        ? keptValue(block.value, resolveInputMap(block.value, {}, run))
        : undefined;
  } catch {
    return { as, not_remembered: 'paths_unreadable' };
  }
  const parts: Record<string, string> = {};
  for (const name of Object.keys(block.key)) {
    const part = keyPartOf(key[name]);
    if ('reason' in part) return { as, not_remembered: part.reason, key_name: name };
    parts[name] = part.text;
  }
  const item = value ?? entry.output_summary;
  if (Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8') > REMEMBER_VALUE_MAX_BYTES) {
    return { as, not_remembered: 'value_too_large' };
  }
  const completedAt = Date.parse(entry.completed_at);
  if (!Number.isFinite(completedAt)) return undefined;
  const choice = entry.kind === 'gate_response' ? entry.input_summary['choice'] : undefined;
  return {
    as,
    key: parts,
    ...(value !== undefined ? { value } : {}),
    ...(typeof choice === 'string' ? { choice } : {}),
    expires_at: new Date(completedAt + block.keep_days * DAY_MS).toISOString(),
  };
}

/**
 * The entries a settle of `stepName` is about to write, with its success entry stamped (the last
 * entry with `status: 'success'`; a gate answer's own entry), and the reply's warning when it
 * remembered nothing. Entries of a step without `remember:` are returned as they are. Total: an
 * unexpected throw leaves the entries unstamped.
 */
export function withRememberedStamp(
  definition: Pick<WorkflowDefinition, 'steps'>,
  stepName: string | undefined,
  entries: EvidenceSnapshot[],
  run: RunRecord,
): { entries: EvidenceSnapshot[]; warning?: string } {
  try {
    const step =
      stepName !== undefined && Object.hasOwn(definition.steps, stepName)
        ? definition.steps[stepName]
        : undefined;
    if (step?.remember === undefined) return { entries };
    let index = entries.length - 1;
    while (index >= 0 && entries[index]!.status !== 'success') index -= 1;
    if (index === -1) return { entries };
    const entry = entries[index]!;
    const reading: RunRecord = { ...run, evidence: [...run.evidence, ...entries] };
    const stamp = rememberedStampOf(step.remember, entry, reading, settledByDefault(entry, run));
    if (stamp === undefined) return { entries };
    const stamped = entries.map((e, i) => (i === index ? { ...e, remembered: stamp } : e));
    return 'not_remembered' in stamp
      ? { entries: stamped, warning: notRememberedWarning(stepName!, stamp) }
      : { entries: stamped };
  } catch {
    return { entries };
  }
}
