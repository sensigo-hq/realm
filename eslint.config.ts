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

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
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
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
);
