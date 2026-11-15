// params-map-check.ts — fix 1, piece 2b: a webhook trigger's `params_map` judged against the
// workflow's `params_schema` when the file loads.
//
// Three loader warning codes carry the findings, in the #169 channel:
//   PARAMS_MAP_UNKNOWN_PARAM (policy 'error') — a `params_map` name a closed `params_schema` does not
//     have: `realm listen` answers 400 params_invalid to each request that carries its value;
//   PARAMS_MAP_REQUIRED_UNMAPPED (policy 'error') — a required parameter no `params_map` name fills:
//     `realm listen` answers 400 params_invalid to every request that reaches its params check (the
//     validator applies no defaults);
//   PARAMS_MAP_UNDECLARED_PARAM (policy 'warn') — a name an open `params_schema` does not list.
// validate, register and watch refuse the two error codes (the #170 boundary); `realm listen` and
// `realm workflow run` print all three and go on.
//
// "Closed" is the shared resolver's rule (`isClosedLevel`), never a second copy. With no
// `params_schema` nothing is judged: `realm listen` then checks no request's parameters.
import { capText } from '../utils/redaction.js';
import {
  closestKey,
  resolveSeverity,
  type LoaderWarning,
  type WarningCode,
} from './diagnostics.js';
import { isClosedLevel } from './path-resolver.js';
import type { SourcePosition } from './source-positions.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const LISTEN_REFUSES =
  'so realm listen answers 400 params_invalid to every request that passes its auth, filter and ' +
  'dedup checks';

/**
 * The findings for one workflow's `trigger` and `params_schema`, every one in one pass. `positionOf`
 * resolves a key's place in the source (the loader's `SourcePositionMap.posOf`).
 */
export function checkParamsMap(
  triggerRaw: unknown,
  paramsSchema: unknown,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LoaderWarning[] {
  if (!isObj(triggerRaw) || !isObj(paramsSchema)) return [];
  // No `params_map` is an empty one (`realm listen` then passes `{}`). One the trigger's own schema
  // refuses (not a map, or a value that is not text) is not judged here.
  const rawMap = triggerRaw['params_map'] ?? {};
  if (!isObj(rawMap)) return [];
  if (!Object.values(rawMap).every((v) => typeof v === 'string' && v !== '')) return [];
  const mapped = Object.keys(rawMap);

  const props = isObj(paramsSchema['properties'])
    ? Object.keys(paramsSchema['properties'])
    : undefined;
  const rawRequired = paramsSchema['required'];
  const required =
    Array.isArray(rawRequired) && rawRequired.every((r) => typeof r === 'string')
      ? [...new Set(rawRequired as string[])]
      : undefined;
  const closed = isClosedLevel(paramsSchema);
  const findings: LoaderWarning[] = [];

  // Item 2: a name that names no declared parameter. The did-you-mean is over the declared names no
  // `params_map` name already names.
  if (props !== undefined) {
    const unnamed = props.filter((p) => !mapped.includes(p));
    for (const k of mapped) {
      if (props.includes(k)) continue;
      const dym = closestKey(k, unnamed);
      const name = capText(k);
      const text = closed
        ? `trigger.params_map.${name}: params_schema has no parameter '${name}' and allows no ` +
          `others, ${LISTEN_REFUSES} and carries this value.` +
          (dym !== undefined ? ` Did you mean '${capText(dym)}'?` : '')
        : `trigger.params_map.${name}: params_schema does not list '${name}' in its properties.` +
          (dym !== undefined
            ? ` Did you mean '${capText(dym)}'? As written, '${capText(dym)}' gets no value from ` +
              `the request.`
            : '');
      findings.push(
        finding(
          closed ? 'PARAMS_MAP_UNKNOWN_PARAM' : 'PARAMS_MAP_UNDECLARED_PARAM',
          text,
          k,
          dym,
          positionOf(['trigger', 'params_map', k]),
          undefined,
        ),
      );
    }
  }

  // Item 3: a required parameter no name fills. The validator applies no defaults.
  if (required !== undefined) {
    const mapPos = positionOf(['trigger', 'params_map']);
    const triggerLine = mapPos === undefined ? positionOf(['trigger'])?.line : undefined;
    for (const p of required) {
      if (mapped.includes(p)) continue;
      const name = capText(p);
      const advice =
        closed && (props === undefined || !props.includes(p))
          ? `Declare '${name}' in params_schema's properties and map it, or remove it from required.`
          : `Map '${name}' to a path in the request, or make it optional in params_schema.`;
      findings.push(
        finding(
          'PARAMS_MAP_REQUIRED_UNMAPPED',
          `trigger.params_map: params_schema requires '${name}', but params_map does not fill it, ` +
            `so realm listen starts no run from this trigger: it answers 400 params_invalid to ` +
            `every request that passes its auth, filter and dedup checks. ${advice}`,
          p,
          undefined,
          mapPos,
          triggerLine,
        ),
      );
    }
  }
  return findings;
}

/**
 * One finding, its line appended after the whole message (#420): ` (line N)` for the key's own
 * line, else ` (trigger at line N)` for the trigger's, else nothing. The structured position is set
 * only when the key itself is placed.
 */
function finding(
  code: WarningCode,
  text: string,
  key: string,
  didYouMean: string | undefined,
  keyPos: SourcePosition | undefined,
  triggerLine: number | undefined,
): LoaderWarning {
  const at =
    keyPos !== undefined
      ? ` (line ${keyPos.line})`
      : triggerLine !== undefined
        ? ` (trigger at line ${triggerLine})`
        : '';
  const out: LoaderWarning = {
    code,
    severity: resolveSeverity(code),
    message: text + at,
    scope: 'workflow',
    key: capText(key),
  };
  if (didYouMean !== undefined) out.did_you_mean = didYouMean;
  if (keyPos !== undefined) {
    out.line = keyPos.line;
    out.column = keyPos.column;
    out.endLine = keyPos.endLine;
    out.endColumn = keyPos.endColumn;
  }
  return out;
}
