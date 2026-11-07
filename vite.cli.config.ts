// Builds the maris terminal command (src/cli) into one Node file, out/cli/maris.cjs, which the app
// ships in resources/cli and runs on its own runtime (ELECTRON_RUN_AS_NODE).
import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  define: { __MARIS_VERSION__: JSON.stringify(pkg.version) },
  build: {
    ssr: resolve(__dirname, 'src/cli/main.ts'),
    outDir: resolve(__dirname, 'out/cli'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "maris.cjs" }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
