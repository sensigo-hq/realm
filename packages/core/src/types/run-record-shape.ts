// run-record-shape.ts — issue #719: the ONE check that a value is a run record, read by admission
// (an entry handed a `run`) and by the JSON store's reader (a run file that is JSON but not a run).
import type { RunRecord } from './run-record.js';

/** The type each required field must have. `present` means any value but `undefined`. */
export type RunRecordFieldType = 'string' | 'number' | 'array' | 'boolean' | 'present';

/**
 * The 14 fields every run record carries (issue #719, R2), in the record's own order, each with the
 * type it must have. Elements of the arrays are not checked. `params` is only required to be
 * present: Realm itself stores `null`, an array, a string or a number as params when `--params`
 * gives one, and reads it back, so a stricter check would make those runs unreadable.
 */
export const RUN_RECORD_REQUIRED_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly type: RunRecordFieldType;
}> = [
  { field: 'id', type: 'string' },
  { field: 'workflow_id', type: 'string' },
  { field: 'workflow_version', type: 'number' },
  { field: 'completed_steps', type: 'array' },
  { field: 'in_progress_steps', type: 'array' },
  { field: 'failed_steps', type: 'array' },
  { field: 'skipped_steps', type: 'array' },
  { field: 'run_phase', type: 'string' },
  { field: 'version', type: 'number' },
  { field: 'params', type: 'present' },
  { field: 'evidence', type: 'array' },
  { field: 'created_at', type: 'string' },
  { field: 'updated_at', type: 'string' },
  { field: 'terminal_state', type: 'boolean' },
];

/** One field a value lacks, or holds with the wrong type. Names only: never the value. */
export interface RunRecordFieldProblem {
  field: string;
  problem: 'missing' | 'wrong_type';
}

function hasType(value: unknown, type: RunRecordFieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'present':
      return value !== undefined;
  }
}

/**
 * Every required field an OBJECT lacks or holds with the wrong type, in the record's field order.
 * The caller decides first that the value is an object (not `null`, not an array).
 */
export function runRecordFieldProblems(value: Record<string, unknown>): RunRecordFieldProblem[] {
  const problems: RunRecordFieldProblem[] = [];
  for (const { field, type } of RUN_RECORD_REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field) || value[field] === undefined) {
      problems.push({ field, problem: 'missing' });
    } else if (!hasType(value[field], type)) {
      problems.push({ field, problem: 'wrong_type' });
    }
  }
  return problems;
}

/** The type a required field must have, as a sentence names it ("not a string", "not an array"). */
export function runRecordFieldTypeWord(field: string): string {
  const type = RUN_RECORD_REQUIRED_FIELDS.find((f) => f.field === field)?.type;
  switch (type) {
    case 'array':
      return 'an array';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return 'set';
  }
}

/** One problem as a clause: `<field> is missing` or `<field> is not <a type>`. */
export function runRecordProblemClause(p: RunRecordFieldProblem): string {
  return p.problem === 'missing'
    ? `${p.field} is missing`
    : `${p.field} is not ${runRecordFieldTypeWord(p.field)}`;
}

/**
 * issue #719 (R2): whether `value` is a run record — an object carrying each of the 14 required
 * fields with its type. The one predicate admission and the JSON store's reader share.
 */
export function isRunRecordShape(value: unknown): value is RunRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    runRecordFieldProblems(value as Record<string, unknown>).length === 0
  );
}
