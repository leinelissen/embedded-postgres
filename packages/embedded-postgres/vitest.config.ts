/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
    test: {
        bail: 1,
        testTimeout: 120_000,
        hookTimeout: 30_000,
    },
})