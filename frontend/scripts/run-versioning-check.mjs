// 用 esbuild（vite 的自带依赖）把 TS 测试入口打包后在 Node + fake-indexeddb 中执行
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'

const entry = process.argv[2] ?? './versioning-check.ts'
const entryUrl = new URL(entry, import.meta.url)
const outfile = new URL('../.tmp-test.mjs', import.meta.url)
await build({
  entryPoints: [entryUrl.pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outfile.pathname,
  packages: 'external',
  logLevel: 'warning'
})

await import(pathToFileURL(outfile.pathname).href)
rmSync(outfile.pathname, { force: true })
