import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            '**/scripts/**',
            '**/*.js',
            '**/*.cjs',
            '**/*.mjs',
        ],
    },
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            indent: [
                'error',
                4,
                { SwitchCase: 1 },
            ],
            'linebreak-style': [
                'error',
                'unix',
            ],
            quotes: [
                'error',
                'single',
            ],
            semi: [
                'error',
                'always',
            ],
        },
    },
);
