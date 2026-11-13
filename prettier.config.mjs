/**
 * Prettier configuration for RecoverX.
 *
 * Formatting is intentionally opinionated and non-negotiable so that no review
 * cycle is ever spent on style. `eslint-config-prettier` disables every ESLint
 * rule that could conflict with these settings.
 *
 * @type {import('prettier').Config}
 */
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: false,
  singleQuote: true,
  quoteProps: 'as-needed',
  jsxSingleQuote: false,
  trailingComma: 'all',
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: 'always',
  endOfLine: 'lf',
  singleAttributePerLine: false,
  overrides: [
    {
      files: ['*.md'],
      options: { proseWrap: 'preserve' },
    },
    {
      files: ['*.json', '*.yml', '*.yaml'],
      options: { singleQuote: false },
    },
  ],
}
