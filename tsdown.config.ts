import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/schemastery',
    'node:*',
  ],
})
