import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [{
  files: ['src/**/*.ts'],
  languageOptions: {
    parser: tsParser,
    parserOptions: { project: './tsconfig.json', sourceType: 'module' },
  },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    'no-undef': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
}];
