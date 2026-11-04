// Root ESLint flat config — applies to all packages
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * issue #367: the one message all six seal-writer selectors share. It names the two sanctioned
 * architectures the shipped tree actually uses, so a developer who trips it has somewhere to go.
 */
const SEAL_WRITER_MESSAGE =
  '`terminal_state` and `sealed_by` must be written in the same object literal — stage ' +
  'seal-fields-first, or route through `sealRunLevel` / the `applyTerminalPostconditions` ' +
  'chokepoint; a suppression requires a reasoned entry in the terminal-writer census. ' +
  'A non-terminal write never carries `sealed_by`.';

/**
 * issue #367 (part 2): the six seal-writer selectors (the rule block below explains them). A flat
 * config's later `no-restricted-syntax` block REPLACES an earlier one's list in the files it matches,
 * so every later block spreads these into its own list (#729 PR-3; a lint cell proves they still
 * fire under each later block).
 */
const SEAL_WRITER_SELECTORS = [
  // 1. Missing sibling: a literal `terminal_state: true` with no `sealed_by` beside it.
  //    The `> Property` child combinator keeps each object judged on its OWN properties.
  {
    selector:
      "ObjectExpression:has(> Property[key.name='terminal_state'][value.raw='true']):not(:has(> Property[key.name='sealed_by']))",
    message: SEAL_WRITER_MESSAGE,
  },
  {
    selector:
      "ObjectExpression:has(> Property[key.value='terminal_state'][value.raw='true']):not(:has(> Property[key.value='sealed_by']))",
    message: SEAL_WRITER_MESSAGE,
  },
  // 2. Assignment ban: a bare assignment can never carry a same-write stamp. Both historical
  //    assignment writers were rewritten in part 1.
  {
    selector: "AssignmentExpression[left.property.name='terminal_state']",
    message: SEAL_WRITER_MESSAGE,
  },
  {
    selector: "AssignmentExpression[left.property.value='terminal_state']",
    message: SEAL_WRITER_MESSAGE,
  },
  // 3. Computed RHS with no sibling. A computed value WITH a sibling passes — part 1 ships
  //    exactly that shape, and banning it outright would ban the compliant architecture.
  {
    selector:
      "ObjectExpression:has(> Property[key.name='terminal_state']:not([value.type='Literal'])):not(:has(> Property[key.name='sealed_by']))",
    message: SEAL_WRITER_MESSAGE,
  },
  {
    selector:
      "ObjectExpression:has(> Property[key.value='terminal_state']:not([value.type='Literal'])):not(:has(> Property[key.value='sealed_by']))",
    message: SEAL_WRITER_MESSAGE,
  },
];

/** #729 PR-3 (M-1): no `as unknown as` inside `toolContentOf(...)`'s arguments — a reply's type is
 *  what its class table is checked against. */
const MCP_CAST_SELECTORS = [
  {
    selector:
      "CallExpression[callee.name='toolContentOf'] TSAsExpression[expression.type='TSAsExpression']",
    message:
      "No `as unknown as` inside toolContentOf's arguments (#729 PR-3, M-1): pass the reply as its own type, so its class table is checked against it.",
  },
];

/** #729 PR-3 (M-5; correction 1, F8): the MCP SDK's other egress calls stay in `toolContentOf`
 *  (the elicit has its own rule below). */
const MCP_EGRESS_SELECTORS = [
  {
    selector: 'MemberExpression[property.name=/^(notification|sendLoggingMessage|createMessage)$/]',
    message:
      'An MCP egress call goes through its wrapper (elicitDisclosedWith in server.ts), which discloses what it sends (#729 PR-3, M-5, F8).',
  },
  {
    selector: "Property[key.name='structuredContent']",
    message: 'structuredContent leaves only through toolContentOf (#729 PR-3, M-5).',
  },
];

/** #729 PR-3 correction 2 (G6; F8): the elicit by name. The identifier `elicitInput` and the method
 *  string `elicitation/create` appear nowhere in mcp-server's sources but at ONE site: the bind
 *  inside `elicitDisclosedWith`'s first argument in server.ts, whose request the wrapper walks. A
 *  static rule cannot see a dynamic key (`s[k]`); the real-form cell carries that. */
const ELICIT_MESSAGE =
  "The elicit leaves only through elicitDisclosedWith's one bind in server.ts, which discloses what it sends (#729 PR-3, F8, G6).";
const ELICIT_SELECTORS = [
  { selector: "Identifier[name='elicitInput']", message: ELICIT_MESSAGE },
  { selector: 'Literal[value=/elicitation.create/]', message: ELICIT_MESSAGE },
  { selector: 'TemplateElement[value.raw=/elicitation.create/]', message: ELICIT_MESSAGE },
];
/** G6: the one allowed site, exactly: `elicitDisclosedWith((…) => x.elicitInput(…) as …, …)`. */
const ELICIT_SITE =
  "CallExpression[callee.name='elicitDisclosedWith'] > ArrowFunctionExpression > TSAsExpression > CallExpression > MemberExpression > Identifier";
const ELICIT_SELECTORS_SERVER = [
  { selector: `Identifier[name='elicitInput']:not(${ELICIT_SITE})`, message: ELICIT_MESSAGE },
  ...ELICIT_SELECTORS.slice(1),
];

/** #729 PR-3 (M-2): a tool's reply is never a hand-built text block. */
const MCP_TEXT_SELECTORS = [
  {
    selector: "Property[key.name='type'][value.value='text']",
    message:
      "A tool's reply leaves through toolContentOf (render-reply.ts), which walks it by its class table and adds the receipt; no hand-built text block (#729 PR-3, M-2).",
  },
];

/** #729 PR-3 (L-2): the print calls whose argument subtree may hold the writer's context. */
const PRINT_CALL =
  "CallExpression[callee.object.name='console'], CallExpression[callee.property.name='write'][callee.object.property.name=/^(stdout|stderr)$/], CallExpression[callee.property.name=/^(info|warn|error)$/][callee.object.property.name='logger'], CallExpression[callee.name='print']";

/** #729 PR-3 (L-2): the writer's context only inside a print call's arguments; composers receive it
 *  from their caller as a parameter. */
const CTX_SELECTORS = [
  {
    selector: `CallExpression[callee.name=/^(writerCtx|writerHost)$/]:not(:matches(${PRINT_CALL}) *)`,
    message:
      "The writer's context (writerCtx/writerHost) appears only inside a print call's arguments (#729 PR-3, L-2): a string built with it and kept, sent or stored would carry span marks.",
  },
];

/** #729 PR-3 (L-2; RECORD 05): a realm command interpolated into a template goes through `ctx.cmd`
 *  (a verified span, printed whole). Prose that names a command carries a disable with its reason. */
const COMMAND_TEMPLATE_SELECTORS = [
  {
    selector:
      "TemplateLiteral[expressions.length>0]:not(CallExpression[callee.property.name='cmd'] > TemplateLiteral) > TemplateElement[value.raw=/realm (agent|run|workflow|listen|mcp|serve) /]",
    message:
      'A realm command with an interpolated value goes through ctx.cmd (#729 PR-3, L-2), so the writer prints it whole; prose that names a command carries a disable comment with its reason.',
  },
];

/** #729 PR-3 correction 1 (F26): on the drive path a command reaches the terminal as a verified span
 *  (`ctx.cmd` from the writer's context), never through `PLAIN.cmd`, whose text the writer masks like
 *  any other. A command built into a value that is returned or kept (an Error's message) carries a
 *  disable comment naming its reason. */
const PLAIN_CMD_SELECTORS = [
  {
    selector: "CallExpression[callee.object.name='PLAIN'][callee.property.name='cmd']",
    message:
      "On the drive path a command is printed through the writer's context (ctx.cmd), a verified span printed whole — never PLAIN.cmd (#729 PR-3, F26); a command built into a value that is returned or kept carries a disable comment with its reason.",
  },
];

/**
 * The zod 4 unit (Z2b): zod 4 still ships the legacy `zod/v3` entry, whose array parse is the
 * UNFIXED one (GHSA-mrhx-c7xc-m3w5). A schema built from it has no `_zod`, so the MCP SDK would parse
 * a tool's arguments on that path, silently. Shared by the two `no-restricted-imports` blocks below:
 * a later block REPLACES an earlier one's list for the files it matches, so the override for tests
 * and the testing package re-states it (#715 (a)).
 */
const ZOD_V3_MESSAGE =
  "zod/v3 is zod 3's unfixed array parse (GHSA-mrhx-c7xc-m3w5): import from 'zod' (zod 4).";
const ZOD_V3_RESTRICTIONS = {
  paths: [{ name: 'zod/v3', message: ZOD_V3_MESSAGE }],
  patterns: [{ group: ['zod/v3/*'], message: ZOD_V3_MESSAGE }],
};

/**
 * #715 (a) (D6-52): production code never creates a test location or writes a clock file (the file
 * store reads one, beside `runs/`). The CLI ships `@sensigo/realm-testing` as a production dependency
 * (for `realm workflow test`), and core exports the clock file's helpers for that package, so both
 * are named here; tests and the testing package are allowed by the override block below. The rule
 * catches static import and export-from declarations; the source scan in
 * `lint-test-location-715.test.ts` finds the names as text in any other form (it reads the `.ts` and
 * `.mjs` files of the four packages' `src` folders, no `.sh` or `.json`, and skips `*.test.ts`).
 */
const TEST_CLOCK_RESTRICTIONS = [
  {
    name: '@sensigo/realm-testing',
    importNames: ['createTestLocation'],
    message:
      'A production module never creates a test location: `createTestLocation` is for tests (#715, D6-52).',
  },
  {
    name: '@sensigo/realm',
    importNames: ['writeTestClockFile', 'fileClock', 'readTestClockFile'],
    message:
      "A production module never creates or reads a test clock: the clock file's helpers are for @sensigo/realm-testing and tests (#715, D6-52).",
  },
  // #715 (b) (04 §B.4): the marks of a test clock. Core uses them by relative import (its stores, the
  // stamp, the notice) and exports them for @sensigo/realm-testing; nothing else in production does.
  {
    name: '@sensigo/realm',
    importNames: ['markTestClock', 'isTestLocationClock', 'clockBasis'],
    message:
      'A production module never creates or reads a test clock: the test-clock marks are for @sensigo/realm-testing and tests (#715, D6-52).',
  },
];

/**
 * #715 (b) (04 §B, D5 §5.3): the clock rule. A run store's time comes from its clock; the host's
 * clock is read only where the clock census names the site `outside`, with its reason
 * (`packages/cli/src/commands/clock-census-715b.test.ts`). Its own rule id, so the later
 * `no-restricted-syntax` blocks (which REPLACE each other's lists) cannot drop it. It flags, outside
 * the allowed sites: `new Date()` with no argument, `Date()`, `Date.now()` (called or taken by name),
 * and — even where a raw read would otherwise be allowed nowhere — a clock-reading parameter default
 * (`now = new Date()`, `now ?? new Date()`). A site is `<package path>#<enclosing function>`, named as
 * the census names it.
 */
const CLOCK_OUTSIDE_SITES = [
  'cli/src/agent/auto-prices.ts#settleAutoFromPriceFile',
  'cli/src/agent/gate/slack-gate-server.ts#startSlackGateServer',
  'cli/src/agent/providers/agent-utils.ts#parseRetryAfterMs',
  'cli/src/agent/providers/anthropic-provider.ts#bounded',
  'cli/src/agent/providers/anthropic-provider.ts#makeRequest',
  'cli/src/agent/providers/openai-provider.ts#bounded',
  'cli/src/agent/providers/openai-provider.ts#makeRequest',
  'cli/src/agent/providers/openai-provider.ts#timedCreate',
  'cli/src/agent/providers/openai-reasoning-provider.ts#makeRequest',
  'cli/src/agent/run-agent.ts#sidecarStamp',
  'cli/src/commands/export.ts#<module>',
  'cli/src/commands/export.ts#buildExportBundle',
  'cli/src/commands/gc.ts#<module>',
  'cli/src/commands/gc.ts#sweepOrphanArtifacts',
  'cli/src/commands/gc.ts#sweepOrphans',
  'cli/src/commands/watch.ts#registerFile',
  'cli/src/commands/watch.ts#renderProfilesGone',
  'cli/src/extensions/extension-identity.ts#computeExtensionIdentity',
  'cli/src/extensions/extension-identity.ts#errorExtensionIdentityEntry',
  'cli/src/lib/dedup-store.ts#FileDedupStore.check',
  'cli/src/lib/dedup-store.ts#FileDedupStore.cleanup',
  'cli/src/lib/dedup-store.ts#FileDedupStore.record',
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.check',
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.evictExpired',
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.record',
  'cli/src/lib/webhook-verifiers.ts#verifyHmac',
  'cli/src/lib/webhook-verifiers.ts#verifyStripe',
  'cli/src/store/replay-store.ts#JsonFileReplayStore.save',
  'core/src/adapters/adapter-utils.ts#parseRetryAfterHeader',
  'core/src/store/trace-buffer-store.ts#InMemoryTraceBufferStore.appendUnlocked',
  'core/src/utils/clock.ts#arm',
  'core/src/utils/clock.ts#now',
  'core/src/utils/clock.ts#tick',
  'mcp-server/src/json-trace-buffer-store.ts#JsonTraceBufferStore.appendWithinCS',
  'mcp-server/src/tools/execute-step.ts#emitFailedAttemptTelemetry',
  'testing/src/store/run-store-fidelity-contract.ts#run',
];

type EsNode = { type: string; parent?: EsNode | null; [k: string]: unknown };
const nameOf = (n: unknown): string | undefined => {
  const x = n as { type?: string; name?: string; value?: unknown } | undefined;
  if (x?.type === 'Identifier') return x.name;
  if (x?.type === 'Literal' && typeof x.value === 'string') return x.value;
  return undefined;
};

/** The enclosing function's name, as the census names it (a class method as `Class.method`). */
function enclosingName(node: EsNode): string {
  // ESLint gives the root node a `null` parent (never `undefined`).
  for (let n = node.parent; n !== undefined && n !== null; n = n.parent) {
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    ) {
      const p = n.parent;
      let name = nameOf(n['id']);
      if (name === undefined && p?.type === 'MethodDefinition') {
        const key = p['kind'] === 'constructor' ? 'constructor' : nameOf(p['key']);
        const cls = p.parent?.parent;
        const clsName = cls !== undefined && cls !== null ? nameOf(cls['id']) : undefined;
        if (key !== undefined) name = clsName !== undefined ? `${clsName}.${key}` : key;
      }
      if (name === undefined && p?.type === 'VariableDeclarator') name = nameOf(p['id']);
      if (name === undefined && p?.type === 'Property') name = nameOf(p['key']);
      if (name === undefined && p?.type === 'PropertyDefinition') name = nameOf(p['key']);
      if (name !== undefined) return name;
    }
  }
  return '<module>';
}

const clockPlugin = {
  rules: {
    'no-clock-read': {
      meta: {
        type: 'problem' as const,
        schema: [
          {
            type: 'object',
            properties: { allow: { type: 'array', items: { type: 'string' } } },
            additionalProperties: false,
          },
        ],
        messages: {
          read: "A clock read outside a run store's clock: read the store's clock (`store.clock.now()`), or — for an instant compared with nothing on a run — name the site in the clock census as `outside` with its reason (#715 (b), 04 §B).",
          dflt: 'A clock-reading parameter default: the caller passes the instant (#715 (b), 04 §B).',
        },
      },
      create(context: {
        filename: string;
        options: [{ allow?: string[] }?];
        report(d: { node: unknown; messageId: 'read' | 'dflt' }): void;
      }) {
        const rel = context.filename.replace(/\\/g, '/').replace(/^.*\/packages\//, '');
        const allow = new Set(context.options[0]?.allow ?? []);
        const allowed = (node: EsNode): boolean => allow.has(`${rel}#${enclosingName(node)}`);
        const isRawRead = (n: EsNode | undefined): boolean =>
          n !== undefined &&
          (((n.type === 'NewExpression' || n.type === 'CallExpression') &&
            nameOf(n['callee']) === 'Date' &&
            (n['arguments'] as unknown[]).length === 0) ||
            (n.type === 'CallExpression' &&
              (n['callee'] as EsNode).type === 'MemberExpression' &&
              nameOf((n['callee'] as EsNode)['object']) === 'Date' &&
              nameOf((n['callee'] as EsNode)['property']) === 'now'));
        const check = (node: EsNode): void => {
          if (allowed(node)) return;
          const p = node.parent;
          const isDefault =
            p?.type === 'AssignmentPattern' ||
            (p?.type === 'LogicalExpression' && p['operator'] === '??' && p['right'] === node);
          context.report({ node, messageId: isDefault ? 'dflt' : 'read' });
        };
        return {
          NewExpression(node: EsNode) {
            if (isRawRead(node)) check(node);
          },
          CallExpression(node: EsNode) {
            if (isRawRead(node)) check(node);
          },
          MemberExpression(node: EsNode) {
            // `Date.now` taken by name (`const now = Date.now`, a callback).
            if (
              nameOf(node['object']) === 'Date' &&
              nameOf(node['property']) === 'now' &&
              !(node.parent?.type === 'CallExpression' && node.parent['callee'] === node) &&
              !allowed(node)
            ) {
              context.report({ node, messageId: 'read' });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        // issue #337: `import.meta.dirname` is ESM-only syntax (TS1470) — this file is
        // CJS-classified by tsc (module: NodeNext, root package.json has no "type" field).
        // `__dirname` is the CJS-native equivalent and resolves identically here (jiti loads
        // this config as CommonJS at lint time, where `__dirname` is always defined).
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The zod 4 unit (Z2b) and #715 (a)'s test clocks: see the two constants above.
      'no-restricted-imports': [
        'error',
        {
          paths: [...ZOD_V3_RESTRICTIONS.paths, ...TEST_CLOCK_RESTRICTIONS],
          patterns: ZOD_V3_RESTRICTIONS.patterns,
        },
      ],
    },
  },
  // #715 (a) (D6-52): tests and the testing package may create and read test clocks — this block
  // REPLACES the list above for those files, so it re-states the zod/v3 restriction without the
  // test-clock members.
  {
    files: ['packages/testing/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', ZOD_V3_RESTRICTIONS],
    },
  },
  // #715 (b) (04 §B): the clock rule, its own rule id — production sources only (tests set time as
  // they need; the test-time rule is `test-time-715b.test.ts`).
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: { realm: clockPlugin },
    rules: {
      'realm/no-clock-read': ['error', { allow: CLOCK_OUTSIDE_SITES }],
    },
  },
  // ---------------------------------------------------------------------------
  // issue #367 (part 2) — the seal-writer source-text rules.
  //
  // A run's terminal write must name the arm that sealed it, and the type system cannot say so:
  // a deleted stamp is zero type errors, which is the class two revisions of this design died on.
  // The store boundary catches it at runtime; these rules catch it at authoring time, which is
  // where a writer gap is cheapest to fix.
  //
  // Scoped to NON-TEST production sources on purpose. Test files are the sanctioned channel for
  // seeding legacy and deliberately-invalid shapes past the boundary — a test file can never be a
  // production writer — and the terminal-writer census owns their story instead.
  //
  // Each rule ships with a `key.value` twin, because a quoted or computed-literal key
  // (`{'terminal_state': true}`, `{['terminal_state']: true}`) parses to a Literal key and evades
  // the `key.name` form entirely. Both twins are execution-verified against a 17-shape matrix.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SEAL_WRITER_SELECTORS],
    },
  },
  // ---------------------------------------------------------------------------
  // #729 PR-3 (M-1, M-2, M-5) — the MCP door's egress. Every reply leaves through `toolContentOf`
  // (render-reply.ts), which walks it by its class table and adds the receipt; the MCP SDK's other
  // egress calls stay in server.ts's wrappers and `toolContentOf`.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/mcp-server/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      'packages/mcp-server/src/render-reply.ts',
      'packages/mcp-server/src/server.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SEAL_WRITER_SELECTORS,
        ...MCP_CAST_SELECTORS,
        ...MCP_EGRESS_SELECTORS,
        ...ELICIT_SELECTORS,
      ],
    },
  },
  // G6: server.ts holds the elicit's one allowed site.
  {
    files: ['packages/mcp-server/src/server.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SEAL_WRITER_SELECTORS,
        ...MCP_CAST_SELECTORS,
        ...MCP_EGRESS_SELECTORS,
        ...ELICIT_SELECTORS_SERVER,
      ],
    },
  },
  // G6: render-reply.ts builds the replies' content (it is `toolContentOf`); of the door's rules it
  // carries the elicit rule only.
  {
    files: ['packages/mcp-server/src/render-reply.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SEAL_WRITER_SELECTORS, ...ELICIT_SELECTORS],
    },
  },
  // ---------------------------------------------------------------------------
  // #729 PR-3 (L-2) — the CLI's drive path: the writer's context and the command templates. The Slack
  // notifier is outside it (its text leaves over HTTP, stripped of marks; its hand-built lines are
  // PR-4/V-2's). The composers take the context as a parameter and may build commands.
  // ---------------------------------------------------------------------------
  {
    files: [
      'packages/cli/src/agent/**/*.ts',
      'packages/cli/src/commands/listen.ts',
      'packages/cli/src/commands/agent.ts',
    ],
    ignores: ['**/*.test.ts', 'packages/cli/src/agent/gate/slack-gate-notifier.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SEAL_WRITER_SELECTORS,
        ...CTX_SELECTORS,
        ...COMMAND_TEMPLATE_SELECTORS,
        ...PLAIN_CMD_SELECTORS,
      ],
    },
  },
  {
    files: ['packages/cli/src/commands/ways-renderer.ts', 'packages/cli/src/lib/holder-render.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SEAL_WRITER_SELECTORS, ...CTX_SELECTORS],
    },
  },
  {
    files: ['packages/mcp-server/src/tools/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SEAL_WRITER_SELECTORS,
        ...MCP_CAST_SELECTORS,
        ...MCP_EGRESS_SELECTORS,
        ...ELICIT_SELECTORS,
        ...MCP_TEXT_SELECTORS,
      ],
    },
  },
);
