import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        bail: 1,
        testTimeout: 120_000,
        hookTimeout: 30_000,
    },
})