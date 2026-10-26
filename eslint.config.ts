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
      // The zod 4 unit (Z2b): zod 4 still ships the legacy `zod/v3` entry, whose array parse is the
      // UNFIXED one (GHSA-mrhx-c7xc-m3w5). A schema built from it has no `_zod`, so the MCP SDK would
      // parse a tool's arguments on that path, silently.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod/v3',
              message:
                "zod/v3 is zod 3's unfixed array parse (GHSA-mrhx-c7xc-m3w5): import from 'zod' (zod 4).",
            },
          ],
          patterns: [
            {
              group: ['zod/v3/*'],
              message:
                "zod/v3 is zod 3's unfixed array parse (GHSA-mrhx-c7xc-m3w5): import from 'zod' (zod 4).",
            },
          ],
        },
      ],
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
