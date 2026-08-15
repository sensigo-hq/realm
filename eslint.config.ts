// Root ESLint flat config — applies to all packages
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
);
