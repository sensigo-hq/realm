/**
 * CP-2: `get_run_state`'s reply shape on the MCP wire. `tools/list` carries the published schema's two
 * shapes (`docs/reference/mcp/run-state.schema.json`, draft 2020-12) under one object root as the
 * tool's `outputSchema`, and every result carries the object its JSON text serializes as
 * `structuredContent`. Before a result leaves, the floor checks that object against the listed
 * schema: a reply of Realm's own that does not fit leaves as an error result whose text is one plain
 * sentence and then the complete reply, never as the SDK's validation error. The results themselves
 * are built where every reply is, in `render-reply.ts`.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import { logMasked, type TwinFloor } from '../render-reply.js';
import { runStateSchemaFile } from './run-state-schema.js';

let wireSchema: z.ZodType | undefined;

/**
 * The tool's `outputSchema`: an object root carrying the file's `$schema`, `title`, `description` and
 * `anyOf` (its two shapes). Built once per process, at the first registration that needs it, and shared
 * by every server the process builds (`realm serve` builds one per request). `.meta()` returns a new
 * schema, so the file's own tree stays unstamped.
 */
export function runStateWireSchema(): z.ZodType {
  if (wireSchema === undefined) {
    const { $schema, title, description, anyOf } = runStateSchemaFile() as {
      $schema: string;
      title: string;
      description: string;
      anyOf: unknown[];
    };
    wireSchema = z.looseObject({}).meta({ $schema, title, description, anyOf });
  }
  return wireSchema;
}

/** Where a reply did not fit, as the floor names it: a data path and a keyword, never a value. */
export interface WireMiss {
  path: string;
  keyword: string;
  message: string;
}

/**
 * For tests only — never a production flag. `twin` replaces the object a result carries, before the
 * floor sees it; `verdict` replaces the floor's check (`undefined` means it fits).
 */
export interface RunStateWireSeam {
  twin?: (twin: Record<string, unknown>) => Record<string, unknown>;
  verdict?: (twin: Record<string, unknown>) => WireMiss | undefined;
}

let seam: RunStateWireSeam | undefined;
let validate: ValidateFunction | undefined;
let compiles = 0;

/** Tests set or clear the seam. */
export function setRunStateWireSeamForTests(next: RunStateWireSeam | undefined): void {
  seam = next;
}

/** How many times this process compiled the floor's validator. */
export function runStateWireCompilesForTests(): number {
  return compiles;
}

/**
 * The listed schema's validator, compiled once per process when the first `get_run_state` result
 * needs it — never on `tools/list` or another tool's call. Ajv's 2020-12 class in strict mode, over
 * the schema exactly as the SDK lists it.
 */
function validator(): ValidateFunction {
  if (validate === undefined) {
    const listed = toJsonSchemaCompat(runStateWireSchema() as never, {
      strictUnions: true,
      pipeStrategy: 'output',
    });
    validate = new Ajv2020({ strict: true }).compile(listed);
    compiles += 1;
  }
  return validate;
}

/**
 * The first error inside the shape the reply belongs to: the run's (`run_phase`) or the refusal's
 * (`status`). The root's own error only when the reply has neither key.
 */
function chosen(twin: Record<string, unknown>, errors: readonly ErrorObject[]): ErrorObject {
  const arm = 'run_phase' in twin ? 0 : 'status' in twin ? 1 : undefined;
  const inArm =
    arm === undefined ? undefined : errors.find((e) => e.schemaPath.startsWith(`#/anyOf/${arm}/`));
  return inArm ?? errors.find((e) => !e.schemaPath.startsWith('#/anyOf/')) ?? errors[0]!;
}

/** Where `twin` does not fit the listed schema, or `undefined` when it fits. */
export function runStateWireMiss(twin: Record<string, unknown>): WireMiss | undefined {
  const check = validator();
  if (check(twin)) return undefined;
  const error = chosen(twin, check.errors ?? []);
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? '',
  };
}

/** The degraded result's first line (exact). */
export function runStateWireMissLine(miss: WireMiss): string {
  return `Realm's reply did not fit its published schema at ${miss.path} (${miss.keyword}: ${miss.message}); the complete reply follows as JSON.`;
}

/**
 * The floor (`toolContentWithTwinOf` builds the result): the object a result carries, and, when it does
 * not fit the listed schema, the plain sentence its error result starts with — then one masked log line
 * names the path and the keyword, never a value.
 */
export const runStateWireFloor: TwinFloor = {
  carried: (twin) => (seam?.twin !== undefined ? seam.twin(twin) : twin),
  refused: (twin) => {
    const miss = seam?.verdict !== undefined ? seam.verdict(twin) : runStateWireMiss(twin);
    if (miss === undefined) return undefined;
    logMasked(
      `realm-mcp: get_run_state's reply did not fit its published schema at ${miss.path} (${miss.keyword}: ${miss.message}).`,
    );
    return runStateWireMissLine(miss);
  },
};
