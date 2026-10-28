// Post-build: checks the bundles and copies the wasm next to them.
import { copyFileSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const dist = new URL('../dist/', import.meta.url).pathname
const files = readdirSync(dist).filter((f) => f.endsWith('.mjs'))
for (const want of ['cli.mjs', 'admin.mjs']) {
  if (!files.includes(want)) throw new Error(`missing dist/${want}`)
}
// Nothing may be loaded from outside the install directory at run time.
const forbidden = [/better-sqlite3/, /from ["'](?!node:)[@a-z][^"']*["']/, /require\(["'](?!node:)[@a-z]/]
for (const f of files) {
  const src = readFileSync(join(dist, f), 'utf8')
  for (const re of forbidden) {
    const m = src.match(re)
    if (m) throw new Error(`dist/${f}: forbidden import ${m[0]}`)
  }
}
const require = createRequire(import.meta.url)
const wasmDir = dirname(require.resolve('@mtcute/wasm/mtcute.wasm'))
for (const w of ['mtcute.wasm', 'mtcute-simd.wasm']) copyFileSync(join(wasmDir, w), join(dist, w))
console.log(`bundle ok: ${files.join(', ')} + wasm`)
