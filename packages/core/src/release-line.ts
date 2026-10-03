// Which copy an object came from (issue #620 PR-C). PR-B made copies of one realm version recognise
// each other's objects and copies of different versions never do. This module makes realm SAY which
// case it is in where project code hands it an object, and CHECK every store a host hands it.
//
// Every refusal and every description about release lines is composed here. realm-cli, realm-mcp
// and realm-testing call these helpers and print what they return.
//
// Nothing here throws on a hostile value: every read of a value realm did not make sits inside a
// `try`. Nothing here refuses on a guess: `ENGINE_RELEASE_LINE_MISMATCH` fires only when an object
// carries realm's identity key with another generation; `ENGINE_RELEASE_LINE_UNDECLARED` states the
// fact that a store declares no line.
import { fileURLToPath } from 'node:url';
import { REALM_BRAND, RELEASE_LINE_KEY } from './brand.js';
import type { RealmBrand } from './brand.js';
import { WorkflowError } from './types/workflow-error.js';
import type { AgentAction, ErrorCategory, ErrorCode } from './types/workflow-error.js';
import { capText } from './utils/redaction.js';

/** The tag `brandClass` puts on the instance check it installs; its value is the class's key. */
const BRAND_CHECK_TAG: symbol = Symbol.for('@sensigo/realm/brand-check');

function isBrand(value: unknown): value is RealmBrand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['package'] === 'string' &&
    typeof v['generation'] === 'string' &&
    typeof v['version'] === 'string'
  );
}

/**
 * The release line an object carries: realm's own classes through PR-B's mark, a host's class or
 * object through {@link declareReleaseLine}. `undefined` when it carries none. One property read,
 * inside a `try`; total.
 */
export function releaseLineOf(value: unknown): RealmBrand | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    const line: unknown = (value as Record<symbol, unknown>)[RELEASE_LINE_KEY];
    if (!isBrand(line)) return undefined;
    // Copy the fields out: the caller never re-reads a hostile object.
    const url = (line as { url?: unknown }).url;
    return {
      package: line.package,
      generation: line.generation,
      version: line.version,
      url: typeof url === 'string' ? url : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * A brand's root folder as a path, or `(path unknown)`. One path form everywhere (text and data):
 * no trailing separator — a brand's `url` names a folder (`file:///…/realm/`), the project side of
 * the advisory is `dirname(package.json)`.
 */
function pathOf(brand: RealmBrand | undefined): string {
  if (brand?.url == null) return '(path unknown)';
  let path: string;
  try {
    path = fileURLToPath(brand.url);
  } catch {
    return '(path unknown)';
  }
  const trimmed = path.replace(/[\\/]+$/, '');
  // A filesystem root ('/', 'C:\\') keeps its separator.
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}

/** `value.constructor?.name`, read inside a `try`; `a plain object` otherwise. */
function classNameOf(value: unknown): string {
  try {
    if (typeof value !== 'object' && typeof value !== 'function') return typeof value;
    if (value === null) return 'null';
    const ctor = (value as { constructor?: unknown }).constructor;
    if (typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name !== 'Object') {
      return ctor.name;
    }
    return 'a plain object';
  } catch {
    return 'a plain object';
  }
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function mismatchError(
  message: string,
  details: Record<string, unknown>,
  stepId?: string,
): WorkflowError {
  return new WorkflowError(message, {
    code: 'ENGINE_RELEASE_LINE_MISMATCH',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
    details,
    ...(stepId !== undefined ? { stepId } : {}),
  });
}

/**
 * Declares that a host's store class (or plain-object store) belongs to this copy of realm. Call it
 * once, from the `@sensigo/realm` your store imports its errors from.
 *
 * A class: the line goes on its prototype. A plain object: a non-enumerable own property. A target
 * that already carries this generation: nothing to do. Another generation: refused.
 */
export function declareReleaseLine(
  target: object | (abstract new (...args: never[]) => object),
): void {
  const isClass =
    typeof target === 'function' &&
    typeof (target as { prototype?: unknown }).prototype === 'object' &&
    (target as { prototype?: unknown }).prototype !== null;
  const holder: object = isClass ? (target as { prototype: object }).prototype : target;
  const existing = releaseLineOf(holder);
  if (existing !== undefined) {
    if (existing.generation === REALM_BRAND.generation) return;
    const name = isClass
      ? (target as { name?: string }).name || 'an anonymous class'
      : classNameOf(target);
    throw mismatchError(
      `declareReleaseLine(${name}): it already carries realm ${existing.version} (${pathOf(existing)}) ` +
        `— it is a realm class, or was declared by another copy of realm, and its line cannot change. ` +
        `Hand realm a store from this @sensigo/realm (${REALM_BRAND.version}, ${pathOf(REALM_BRAND)}), ` +
        `or ${ONE_VERSION_REMEDY}`,
      {
        role: 'declareReleaseLine',
        class: name,
        local_version: REALM_BRAND.version,
        local_path: pathOf(REALM_BRAND),
        foreign_version: existing.version,
        foreign_path: pathOf(existing),
      },
    );
  }
  if (!Object.isExtensible(holder)) {
    const name = isClass
      ? (target as { name?: string }).name || 'an anonymous class'
      : classNameOf(target);
    throw new WorkflowError(
      `declareReleaseLine(${name}): the ${isClass ? "class's prototype" : 'object'} cannot be ` +
        `extended (it is frozen, sealed or non-extensible). Declare the class, or declare the ` +
        `object before freezing it.`,
      { code: 'ENGINE_INTERNAL', category: 'ENGINE', agentAction: 'stop', retryable: false },
    );
  }
  Object.defineProperty(holder, RELEASE_LINE_KEY, {
    value: REALM_BRAND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/** What realm can say about an object an `instanceof <realm class>` check refused. */
export type Unrecognised =
  | { kind: 'foreign_line'; local: RealmBrand; foreign: RealmBrand; className: string }
  | { kind: 'unbranded_copy'; local: RealmBrand; className: string }
  | { kind: 'not_realm' };

/**
 * Says why `value instanceof Class` answered false. Call it only right after that check answered
 * false.
 *
 * `foreign_line`: the value carries `Class`'s identity key with another generation (proof).
 * `unbranded_copy`: a constructor on its prototype chain has `Class`'s name but no mark (a hedge).
 * `not_realm`: anything else, including a value that throws when read.
 */
/** Any realm class: what `describeUnrecognised` and `assertRegistryLine` take. */
export type RealmClass = abstract new (...args: never[]) => object;

export function describeUnrecognised(value: unknown, Class: RealmClass): Unrecognised {
  let key: unknown;
  let local: unknown;
  let className: string;
  try {
    if (!Object.hasOwn(Class, Symbol.hasInstance)) return { kind: 'not_realm' };
    const check: unknown = (Class as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
    if (typeof check !== 'function') return { kind: 'not_realm' };
    key = (check as unknown as Record<symbol, unknown>)[BRAND_CHECK_TAG];
    if (typeof key !== 'symbol') return { kind: 'not_realm' };
    local = (Class.prototype as Record<symbol, unknown>)[key];
    if (!isBrand(local)) return { kind: 'not_realm' };
    className = Class.name;
  } catch {
    return { kind: 'not_realm' };
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return { kind: 'not_realm' };
  }
  try {
    const mark: unknown = (value as Record<symbol, unknown>)[key as symbol];
    if (typeof mark === 'object' && mark !== null) {
      const generation = (mark as { generation?: unknown }).generation;
      if (typeof generation === 'string') {
        const m = mark as Record<string, unknown>;
        const url = m['url'];
        return {
          kind: 'foreign_line',
          local,
          foreign: {
            package: typeof m['package'] === 'string' ? m['package'] : '(unknown package)',
            generation,
            version: typeof m['version'] === 'string' ? m['version'] : generation,
            url: typeof url === 'string' ? url : null,
          },
          className,
        };
      }
    }
    for (
      let proto: unknown = Object.getPrototypeOf(value);
      proto !== null && proto !== undefined;
      proto = Object.getPrototypeOf(proto)
    ) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'constructor');
      const ctor: unknown = desc?.value;
      if (typeof ctor === 'function' && ctor.name === className) {
        return { kind: 'unbranded_copy', local, className };
      }
    }
    return { kind: 'not_realm' };
  } catch {
    return { kind: 'not_realm' };
  }
}

/** The clause appended to today's message for a same-named class with no mark. */
export function unbrandedClause(className: string): string {
  return (
    ` — it looks like realm's ${className} by its class name but carries no release mark: an ` +
    `older realm copy that does not mark its classes, or another library's class of the same name.`
  );
}

/** The tail every "install one version" remedy shares. */
const ONE_VERSION_REMEDY =
  'install every @sensigo package at one version (npm ls @sensigo/realm in the project, or ' +
  'npm ls -g @sensigo/realm for a global install, lists the copies).';

/**
 * The remedy a hand-off refusal ends with (`assertReleaseLine`'s mismatch, `assertRegistryLine`):
 * the noun comes from the role (`the run reader handed to …` → a reader).
 */
function handOffRemedy(role: string, engineVersion: string): string {
  const noun = /\bregistry\b/.test(role)
    ? 'registry'
    : /\breader\b/.test(role)
      ? 'reader'
      : 'store';
  return `Hand realm a ${noun} from @sensigo/realm ${engineVersion}, or ${ONE_VERSION_REMEDY}`;
}

/** `npm install --save-dev @sensigo/realm-cli<which>, then npx realm` — the command route. */
function commandRoute(which: string): string {
  return `npm install --save-dev @sensigo/realm-cli${which}, then npx realm`;
}

/**
 * The code routes of the ONE remedy for code from another realm version (issue #620 PR-C rounds 3
 * and 4), as a clause: lower-case, no full stop. `engineVersion` is the running engine's (E),
 * `otherVersion` the other copy's (F; `undefined` for an unmarked copy). Two routes, both true: put
 * E in the project the code imports realm from — with every other @sensigo package the project has,
 * so the project's own `npx realm` does not get the reverse failure — or run the realm command at F,
 * whose own realm then is the code's.
 */
function codeRoutes(engineVersion: string, otherVersion: string | undefined): string {
  const commandPart =
    otherVersion !== undefined
      ? `run version ${otherVersion} there: ${commandRoute(`@${otherVersion}`)}`
      : `run the version the project has: ${commandRoute('@<that version>')} ` +
        '(npm ls @sensigo/realm shows that version)';
  return (
    `install @sensigo/realm@${engineVersion} (and every other @sensigo package the project has, at ` +
    `${engineVersion}) in the project your code imports it from, or, when you run the realm ` +
    `command, ${commandPart}`
  );
}

/**
 * The ONE remedy, as a sentence. `form: 'provider'` (the provider refusal) puts the command route
 * first and moves realm-cli AND realm to E on the other route: installing only the matching
 * realm-cli moves the failure to the next crossing (a handler's error).
 */
function releaseLineRemedy(
  engineVersion: string,
  otherVersion: string | undefined,
  form: 'code' | 'provider' = 'code',
): string {
  if (form === 'provider' && otherVersion !== undefined) {
    return (
      `Run realm ${otherVersion} in the project: ${commandRoute(`@${otherVersion}`)}; or install ` +
      `@sensigo/realm-cli@${engineVersion} and @sensigo/realm@${engineVersion} in the project.`
    );
  }
  return `${capitalise(codeRoutes(engineVersion, otherVersion))}.`;
}

/** Stores realm has already checked against this core: a later check is one lookup. */
const accepted = new WeakSet<object>();

/**
 * Checks a store or reader a host hands realm, before any work. Its release line must be this
 * core's: another line is refused as `ENGINE_RELEASE_LINE_MISMATCH` (proof), no line as
 * `ENGINE_RELEASE_LINE_UNDECLARED` (a fact). `role` names the parameter and the function: `the run
 * store handed to executeChain`.
 */
export function assertReleaseLine(value: unknown, role: string): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (accepted.has(value)) return;
  }
  const line = releaseLineOf(value);
  if (line !== undefined && line.generation === REALM_BRAND.generation) {
    accepted.add(value as object);
    return;
  }
  const cls = classNameOf(value);
  const classPart = cls === 'a plain object' ? 'a plain object' : `class ${cls}`;
  const localVersion = REALM_BRAND.version;
  const localPath = pathOf(REALM_BRAND);
  if (line !== undefined) {
    throw mismatchError(
      `${capitalise(role)} (${classPart}) belongs to realm ${line.version} (${pathOf(line)}); ` +
        `this engine runs realm ${localVersion} (${localPath}). Realm objects do not cross ` +
        `versions. ${handOffRemedy(role, localVersion)}`,
      {
        role,
        class: cls,
        local_version: localVersion,
        local_path: localPath,
        foreign_version: line.version,
        foreign_path: pathOf(line),
      },
    );
  }
  const declareFrom = 'imported from the @sensigo/realm your store imports its errors from.';
  // By subject: a plain object has no class that could be realm's own.
  const remedy =
    cls === 'a plain object'
      ? `Declare it once: declareReleaseLine(store), ${declareFrom}`
      : `If the class is yours, declare it once: declareReleaseLine(${cls}), ${declareFrom} If it ` +
        `is realm's own class, it comes from a realm too old to mark its classes: ${ONE_VERSION_REMEDY}`;
  throw new WorkflowError(
    `${capitalise(role)} (${classPart}) declares no realm release line. Realm identifies store ` +
      `errors by class, so every store it runs against must belong to the realm it runs on ` +
      `(${localVersion}). ${remedy}`,
    {
      code: 'ENGINE_RELEASE_LINE_UNDECLARED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      details: { role, class: cls, local_version: localVersion, local_path: localPath },
    },
  );
}

/**
 * Checks a registry a host hands realm. Refused only on proof: a registry from another realm
 * version (`ENGINE_RELEASE_LINE_MISMATCH`). A same-named class with no mark, or a non-realm object,
 * is accepted — each crossing its contents make is described where it happens.
 */
export function assertRegistryLine(value: unknown, role: string, Class: RealmClass): void {
  if (value === undefined) return;
  let recognised: boolean;
  try {
    recognised = value instanceof Class;
  } catch {
    return;
  }
  if (recognised) return;
  const d = describeUnrecognised(value, Class);
  if (d.kind !== 'foreign_line') return;
  throw mismatchError(
    `${capitalise(role)} (class ${d.className}) belongs to realm ${d.foreign.version} ` +
      `(${pathOf(d.foreign)}); this engine runs realm ${d.local.version} (${pathOf(d.local)}). ` +
      `Realm objects do not cross versions. ${handOffRemedy(role, d.local.version)}`,
    {
      role,
      class: d.className,
      local_version: d.local.version,
      local_path: pathOf(d.local),
      foreign_version: d.foreign.version,
      foreign_path: pathOf(d.foreign),
    },
  );
}

/** A foreign error's code, bounded and cleaned for printing; `undefined` unless a string. */
function boundForeignCode(code: unknown): string | undefined {
  if (typeof code !== 'string') return undefined;
  let out = '';
  for (const ch of capText(code)) {
    const c = ch.charCodeAt(0);
    out += c <= 0x1f || c === 0x7f ? '?' : ch;
  }
  return out;
}

/**
 * The one mint for the use sites (an adapter's, handler's or dispatcher's thrown value that an
 * `instanceof WorkflowError` refused). `foreign_line`: `ENGINE_RELEASE_LINE_MISMATCH` naming both
 * copies and the remedy. `unbranded_copy`: the caller's own code and message with the hedged clause,
 * what was not used if the class is realm's, and the remedy with the other version unknown.
 */
export function releaseLineError(
  d: Exclude<Unrecognised, { kind: 'not_realm' }>,
  context: {
    role: string;
    message: string;
    code: ErrorCode;
    category?: ErrorCategory;
    agentAction?: AgentAction;
    retryable?: boolean;
    stepId?: string;
    foreignCode?: unknown;
  },
): WorkflowError {
  const localPath = pathOf(d.local);
  if (d.kind === 'foreign_line') {
    const foreignCode = boundForeignCode(context.foreignCode);
    const codeClause =
      foreignCode !== undefined
        ? `so its code '${foreignCode}' and its retry setting were not used`
        : 'so its code and its retry setting were not used';
    const foreignPath = pathOf(d.foreign);
    return mismatchError(
      `${context.role} threw a ${d.className} from realm ${d.foreign.version} (${foreignPath}); ` +
        `this engine runs realm ${d.local.version} (${localPath}). Realm objects do not cross ` +
        `versions, ${codeClause}. ${releaseLineRemedy(d.local.version, d.foreign.version)}`,
      {
        unrecognised: {
          class: d.className,
          kind: 'foreign_line',
          foreign_version: d.foreign.version,
          foreign_path: foreignPath,
          local_version: d.local.version,
          local_path: localPath,
          ...(foreignCode !== undefined ? { foreign_code: foreignCode } : {}),
        },
      },
      context.stepId,
    );
  }
  // An unmarked same-named class: what was lost if it is realm's, and — under the same condition —
  // the way out with the other version unknown (issue #620 PR-C rounds 3 and 4): one sentence.
  const foreignCode = boundForeignCode(context.foreignCode);
  const lost =
    foreignCode !== undefined
      ? `its code '${foreignCode}' and its retry setting were not used`
      : 'its code and its retry setting were not used';
  return new WorkflowError(
    `${context.message}${unbrandedClause(d.className)} If it is realm's, ${lost}: ` +
      `${codeRoutes(d.local.version, undefined)}.`,
    {
      code: context.code,
      category: context.category ?? 'ENGINE',
      agentAction: context.agentAction ?? 'stop',
      retryable: context.retryable ?? false,
      details: {
        unrecognised: {
          class: d.className,
          kind: 'unbranded_copy',
          local_version: d.local.version,
          local_path: localPath,
          ...(foreignCode !== undefined ? { foreign_code: foreignCode } : {}),
        },
      },
      ...(context.stepId !== undefined ? { stepId: context.stepId } : {}),
    },
  );
}

/**
 * The one total way to print a thrown value: an `Error`'s message, a string as itself, `null` and
 * `undefined` by name, anything else through `String` — `(unreadable error)` / `(unprintable
 * value)` when that throws.
 */
export function describeThrown(value: unknown): string {
  let isError: boolean;
  try {
    isError = value instanceof Error;
  } catch {
    isError = false;
  }
  if (isError) {
    try {
      const message: unknown = (value as Error).message;
      return typeof message === 'string' ? message : String(message);
    } catch {
      return '(unreadable error)';
    }
  }
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return String(value);
  } catch {
    return '(unprintable value)';
  }
}

/**
 * The provider gate's refusal for a provider module whose `LlmProvider` comes from another
 * realm-cli: the lines realm-cli prints to stderr before exiting 1.
 */
export function describeForeignProvider(
  d: Extract<Unrecognised, { kind: 'foreign_line' }>,
): string[] {
  return [
    `Error: the provider module's ${d.className} comes from ${d.foreign.package} ${d.foreign.version} ` +
      `(${pathOf(d.foreign)}); this realm command is ${d.local.package} ${d.local.version} ` +
      `(${pathOf(d.local)}). Realm objects do not cross versions. ` +
      releaseLineRemedy(d.local.version, d.foreign.version, 'provider'),
  ];
}

/**
 * The text realm-testing's contracts print when a store's refusal is not this copy's class: what
 * the description says about it.
 */
export function describeUnrecognisedForContract(d: Unrecognised): string {
  if (d.kind === 'foreign_line') {
    return (
      `got a ${d.className} from realm ${d.foreign.version} (${pathOf(d.foreign)}), not this ` +
      `copy's (${d.local.version})`
    );
  }
  if (d.kind === 'unbranded_copy') {
    return `got a ${d.className}${unbrandedClause(d.className)}`;
  }
  return '';
}

/**
 * The facts a `REALM_RELEASE_LINE_MISMATCH` warning carries as data. `installed_by` is `'project'`
 * for the project's own copy, else the package that installed it (`@sensigo/realm-cli`).
 */
export interface ReleaseLineFacts {
  project: { version: string; path: string; installed_by: string };
  engine: { version: string; path: string };
}

/** The engine side of the advisory: this core's version and folder. */
export function engineReleaseLine(): { version: string; path: string } {
  return { version: REALM_BRAND.version, path: pathOf(REALM_BRAND) };
}

/** The advisory's text: the project's `@sensigo/realm` is not the running one. */
export function releaseLineAdvisoryMessage(facts: ReleaseLineFacts): string {
  const by =
    facts.project.installed_by === 'project'
      ? 'installed by the project'
      : `installed by ${facts.project.installed_by}`;
  // No engine path in the sentence: several copies of one version can serve one command (realm-cli's,
  // realm-mcp's, realm-testing's); the refusal names the copy that refused. The path stays in the data.
  return (
    `Your project's @sensigo/realm is ${facts.project.version} (${facts.project.path}, ${by}); ` +
    `this realm command runs @sensigo/realm ${facts.engine.version}. Realm objects do not cross ` +
    `versions: a WorkflowError your handlers or adapters throw is not recognised — its step fails ` +
    `after one attempt, without that error's own code and retry setting. ` +
    releaseLineRemedy(facts.engine.version, facts.project.version)
  );
}
