// CP-3a-i: the word lists that were written twice (a type union and a loader-local set) live here
// once each. The loader's checks and the published schema of the workflow file
// (`workflow-schema.ts`) read them; the public unions keep their own text. Each list is checked
// against its union both ways at compile time, the device `TRIGGER_RULES` uses: a word in the
// union and not the list, or in the list and not the union, fails `tsc`. Trigger rules already
// have their one list, `TRIGGER_RULES` (types/workflow-definition.ts). No entry re-exports this
// module, so nothing here is a library name.
import type {
  ContextWrapperFormat,
  ExecutionMode,
  FinalizerTrigger,
  StepDefinition,
} from '../types/workflow-definition.js';

/** The kinds a step's `execution` takes. */
export const EXECUTION_KINDS = [
  'auto',
  'agent',
  'guard',
  'finalizer',
] as const satisfies readonly ExecutionMode[];
type MissingExecutionKinds = Exclude<ExecutionMode, (typeof EXECUTION_KINDS)[number]>;
const _everyExecutionKindListed: [MissingExecutionKinds] extends [never]
  ? true
  : MissingExecutionKinds = true;
void _everyExecutionKindListed;

/** The endings a finalizer's `on_outcome` takes. `completed_with_failed_steps` (issue #302) is
 *  author-opt-in: it fires in addition to `complete`/`always` on a complete seal that still carries
 *  failed steps, never on a clean complete. */
export const FINALIZER_TRIGGERS = [
  'complete',
  'fail',
  'abort',
  'always',
  'completed_with_failed_steps',
] as const satisfies readonly FinalizerTrigger[];
type MissingFinalizerTriggers = Exclude<FinalizerTrigger, (typeof FINALIZER_TRIGGERS)[number]>;
const _everyFinalizerTriggerListed: [MissingFinalizerTriggers] extends [never]
  ? true
  : MissingFinalizerTriggers = true;
void _everyFinalizerTriggerListed;

type ServiceMethod = NonNullable<StepDefinition['service_method']>;
/** The methods an `auto` step's `service_method` takes. */
export const SERVICE_METHODS = [
  'fetch',
  'create',
  'update',
  'delete',
] as const satisfies readonly ServiceMethod[];
type MissingServiceMethods = Exclude<ServiceMethod, (typeof SERVICE_METHODS)[number]>;
const _everyServiceMethodListed: [MissingServiceMethods] extends [never]
  ? true
  : MissingServiceMethods = true;
void _everyServiceMethodListed;

/** The ways `context_wrapper` marks off a workflow-context file in a prompt. */
export const CONTEXT_WRAPPER_FORMATS = [
  'xml',
  'brackets',
  'none',
] as const satisfies readonly ContextWrapperFormat[];
type MissingContextWrapperFormats = Exclude<
  ContextWrapperFormat,
  (typeof CONTEXT_WRAPPER_FORMATS)[number]
>;
const _everyContextWrapperFormatListed: [MissingContextWrapperFormats] extends [never]
  ? true
  : MissingContextWrapperFormats = true;
void _everyContextWrapperFormatListed;
