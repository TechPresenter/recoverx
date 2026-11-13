import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

/**
 * Flat ESLint configuration for RecoverX.
 *
 * The rule set is split by execution domain because the three processes have
 * genuinely different hazards:
 *   - main/preload: Node globals, no DOM, strict boundary discipline
 *   - renderer:     DOM globals, React rules, accessibility rules
 *   - tests:        the same rules, minus production-only restrictions
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'scripts/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.vite/**',
      'native/**/target/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // server-php/scripts: the PHP licence server's Node build tooling.
          allowDefaultProject: ['*.mjs', '*.js', 'server-php/scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // --- Correctness ------------------------------------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-alert': 'error',
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'object-shorthand': ['error', 'always'],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message:
            'Parse untrusted JSON through a Zod schema (see src/shared/utils/json.ts) so malformed persisted state cannot crash the process.',
        },
      ],

      // --- TypeScript discipline -------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
    },
  },

  // --- Main + preload: Node domain ----------------------------------------
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '../renderer/*', '**/renderer/**'],
              message:
                'The main and preload processes must never import renderer code. Share types through src/shared instead.',
            },
          ],
        },
      ],
    },
  },

  // --- Licence server: vendor-side Node service ---------------------------
  // Deployed on its own, in a container that has no Electron and no renderer.
  // It may use the shared kernel and the Electron-free SQLite wrapper; any
  // other main-process module could drag Electron into the bundle and break
  // the server at start-up on a machine where Electron does not exist.
  {
    files: ['src/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'The licence server runs without Electron. Use Node built-ins.',
            },
          ],
          patterns: [
            {
              group: [
                'electron/*',
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                '@/*',
                '**/renderer/**',
                '@preload/*',
                '**/preload/**',
              ],
              message:
                'The licence server must not import Electron, React, renderer or preload code.',
            },
            {
              // gitignore semantics: a file cannot be re-included once its
              // directory is excluded, so each level is excluded and the one
              // permitted path re-included in turn.
              group: [
                '@main/*',
                '!@main/database',
                '@main/database/*',
                '!@main/database/sqlite',
                '../main/*',
                '!../main/database',
                '../main/database/*',
                '!../main/database/sqlite',
              ],
              message:
                'The licence server may import only the Electron-free src/main/database/sqlite.ts from the main process. Share anything else through src/shared.',
            },
          ],
        },
      ],
    },
  },

  // --- Renderer: browser domain -------------------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/heading-has-content': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-autofocus': ['warn', { ignoreNonDOM: true }],
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@main/*', '**/main/**', 'electron', 'node:*', 'better-sqlite3', 'winston'],
              message:
                'The renderer is sandboxed. Reach the main process only through window.recoverx (src/renderer/lib/ipc-client.ts).',
            },
          ],
        },
      ],
    },
  },

  // --- Shared kernel: must stay isomorphic --------------------------------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'react', 'react-dom', '@main/*', '@/*'],
              message:
                'src/shared must run unchanged in both the main and renderer processes: no Electron, Node or React imports.',
            },
          ],
        },
      ],
    },
  },

  // --- Tests ---------------------------------------------------------------
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // --- Build tooling (untyped JS configs) ---------------------------------
  {
    files: ['*.mjs', '*.js', 'server-php/scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
)
