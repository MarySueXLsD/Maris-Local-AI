import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // The MCP SDK (connectors) is bundled: only its client part is used, and its full dependency
      // tree (an HTTP server framework among others) would otherwise ship with the app. The same goes
      // for the Anthropic SDK (Claude models): bundled, so the installed app needs no node_modules for it.
      externalizeDeps: { exclude: ['@modelcontextprotocol/sdk', '@anthropic-ai/sdk'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
