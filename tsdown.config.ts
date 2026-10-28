import { defineConfig } from 'tsdown'

// Two self-contained bundles. Every dependency is bundled, so the
// root-owned install directory holds all the code that runs.
export default defineConfig({
  clean: true,
  dts: false,
  entry: { cli: 'src/cli.ts', admin: 'src/admin-main.ts' },
  format: 'esm',
  outExtensions: () => ({ js: '.mjs' }),
  minify: false,
  outDir: 'dist',
  platform: 'node',
  sourcemap: false,
  target: 'node24',
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
})
