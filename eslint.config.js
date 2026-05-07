import pluginVue from 'eslint-plugin-vue'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import vueParser from 'vue-eslint-parser'

export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'src-tauri/**'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: false }],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'prefer-const': 'error',
            'no-var': 'error',
            'max-lines': ['warn', { max: 350, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
        },
    },
    // Test files: describe/it nesting naturally produces large function bodies.
    // Relax max-lines to 500 and disable per-function limit entirely.
    {
        files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
        rules: {
            'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': 'off',
        },
    },
    ...pluginVue.configs['flat/recommended'],
    {
        files: ['src/**/*.vue'],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tsParser,
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: false }],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'vue/multi-word-component-names': 'off',
            'vue/html-self-closing': 'off',
            'vue/singleline-html-element-content-newline': 'off',
            'vue/max-attributes-per-line': 'off',
            'vue/first-attribute-linebreak': 'off',
            'vue/html-closing-bracket-newline': 'off',
            // SFC includes template + script + style — 350 is unrealistic.
            'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
        },
    },
]
