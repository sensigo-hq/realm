// name-check.ts — fix 1, piece 4: a handler or adapter a step needs that the project does not
// provide, warned when the file loads with the project's registry (validate, register, watch).
//
// Two loader warning codes, both policy 'warn' — never a refusal, because another runner may provide
// the name (#134, #631):
//   HANDLER_NOT_PROVIDED — an auto step's handler, or a finalizer's;
//   ADAPTER_NOT_PROVIDED — the adapter of a service an auto step uses, once per service.
//
// What a step needs is `requirementForStep`'s answer, the rule the run's pre-flight and the run-time
// block use, so the three never disagree. A finalizer's handler is the one addition. "Provided" means
// the registry has the name, or the project's realm.yaml declares it in that kind's section (sentinel
// mode skips an entry it cannot build, and says why).
import { requirementForStep } from '../engine/capability.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import { capText } from '../utils/redaction.js';
import {
  closestKey,
  resolveSeverity,
  type LoaderWarning,
  type WarningCode,
} from './diagnostics.js';
import type { SourcePosition } from './source-positions.js';

/**
 * The handler and adapter names the project's realm.yaml declares, built or not.
 * @public
 */
export interface DeclaredNames {
  readonly handlers?: readonly string[];
  readonly adapters?: readonly string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** At most this many provided names are listed; the rest are counted. */
const LIST_MAX = 10;

/**
 * The findings for one workflow's steps and services against the project's registry and declared
 * names, in the steps' file order. `positionOf` resolves a key's place in the source.
 */
export function checkProvidedNames(
  stepsRaw: unknown,
  servicesRaw: unknown,
  registry: ExtensionRegistry,
  declared: DeclaredNames | undefined,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LoaderWarning[] {
  if (!isObj(stepsRaw)) return [];
  // A service entry that is not a map (YAML null: `mail:` with nothing under it) is skipped, so a step
  // that uses it needs nothing here; reading its `adapter` would throw (correction 1).
  const services = isObj(servicesRaw)
    ? Object.fromEntries(Object.entries(servicesRaw).filter(([, v]) => isObj(v)))
    : {};
  const provided = {
    handler: [...new Set([...registry.names('handler'), ...(declared?.handlers ?? [])])].sort(),
    adapter: [...new Set([...registry.names('adapter'), ...(declared?.adapters ?? [])])].sort(),
  };
  const findings: LoaderWarning[] = [];
  const reported = new Set<string>();

  for (const [stepName, raw] of Object.entries(stepsRaw)) {
    if (!isObj(raw)) continue;
    if (raw['execution'] === 'finalizer') {
      const handler = raw['handler'];
      if (typeof handler === 'string' && !provided.handler.includes(handler)) {
        findings.push(
          finding(
            'HANDLER_NOT_PROVIDED',
            `Step '${capText(stepName)}': handler '${capText(handler)}' is not one this project ` +
              `provides (it provides: ${list(provided.handler)}), so when a run here ends in a way ` +
              `its 'on_outcome' selects, this cleanup step, and every cleanup step after it, is left ` +
              `pending instead of running. ` +
              REMEDY('handler', handler),
            handler,
            provided.handler,
            stepPosition(stepName, 'handler', positionOf),
            stepName,
          ),
        );
      }
      continue;
    }
    // The run's own rule: auto steps only; a service's adapter, else the step's handler.
    const need = requirementForStep(
      stepName,
      raw as unknown as StepDefinition,
      {
        services,
      } as unknown as WorkflowDefinition,
    );
    if (need === undefined || typeof need.name !== 'string') continue;
    if (need.kind === 'handler') {
      if (provided.handler.includes(need.name)) continue;
      findings.push(
        finding(
          'HANDLER_NOT_PROVIDED',
          `Step '${capText(stepName)}': handler '${capText(need.name)}' is not one this project ` +
            `provides (it provides: ${list(provided.handler)}), so a run here is blocked at this ` +
            `step and stays open (not failed). ` +
            REMEDY('handler', need.name),
          need.name,
          provided.handler,
          stepPosition(stepName, 'handler', positionOf),
          stepName,
        ),
      );
      continue;
    }
    // An adapter: once per service, at the first step in the file that uses it.
    const service = raw['uses_service'];
    if (typeof service !== 'string' || reported.has(service)) continue;
    reported.add(service);
    if (provided.adapter.includes(need.name)) continue;
    findings.push(
      finding(
        'ADAPTER_NOT_PROVIDED',
        `Service '${capText(service)}': adapter '${capText(need.name)}' is not one this project ` +
          `provides (it provides: ${list(provided.adapter)}), so each step that uses it ` +
          `('${capText(stepName)}' is the first in the file) is blocked when a run reaches it, and ` +
          `the run stays open (not failed). ` +
          REMEDY('adapter', need.name),
        need.name,
        provided.adapter,
        servicePosition(service, positionOf),
        undefined,
      ),
    );
  }
  return findings;
}

const REMEDY = (kind: 'handler' | 'adapter', name: string): string =>
  `A runner that provides '${capText(name)}' can run it. Declare it under '${kind}s:' in ` +
  `realm.yaml or in the workflow's 'extensions' module, or correct the name.`;

/** The provided names, sorted, at most ten, then how many more. */
function list(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, LIST_MAX).map((n) => capText(n));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** Where a finding points: the key's own line, else its anchor's, with the anchor named. */
interface Place {
  key: SourcePosition | undefined;
  anchorLine: number | undefined;
  anchor: 'step' | 'service';
}

function stepPosition(
  stepName: string,
  key: string,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): Place {
  return {
    key: positionOf(['steps', stepName, key]),
    anchorLine: positionOf(['steps', stepName])?.line,
    anchor: 'step',
  };
}

function servicePosition(
  service: string,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): Place {
  return {
    key: positionOf(['services', service, 'adapter']),
    anchorLine: positionOf(['services', service])?.line,
    anchor: 'service',
  };
}

/**
 * One finding: the remedy, then the did-you-mean when one is close, then the line (#420): ` (line N)`
 * for the key's own line, else ` (<anchor> at line N)`, else nothing.
 */
function finding(
  code: WarningCode,
  text: string,
  name: string,
  candidates: readonly string[],
  place: Place,
  /** The step the finding is on; a service's finding is the workflow's. */
  step: string | undefined,
): LoaderWarning {
  const dym = closestKey(name, candidates);
  const at =
    place.key !== undefined
      ? ` (line ${place.key.line})`
      : place.anchorLine !== undefined
        ? ` (${place.anchor} at line ${place.anchorLine})`
        : '';
  const out: LoaderWarning = {
    code,
    severity: resolveSeverity(code),
    message: text + (dym !== undefined ? ` Did you mean '${capText(dym)}'?` : '') + at,
    scope: step !== undefined ? 'step' : 'workflow',
    ...(step !== undefined ? { step } : {}),
    key: capText(name),
  };
  if (dym !== undefined) out.did_you_mean = dym;
  if (place.key !== undefined) {
    out.line = place.key.line;
    out.column = place.key.column;
    out.endLine = place.key.endLine;
    out.endColumn = place.key.endColumn;
  }
  return out;
}
