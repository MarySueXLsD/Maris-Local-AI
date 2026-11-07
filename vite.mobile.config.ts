// Builds the phone app's web part (src/renderer/remote) into mobile/www for Capacitor.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/remote'),
  base: './',
  // The same static files as the desktop window (the model cards' example pictures and clips).
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared'), '@renderer': resolve(__dirname, 'src/renderer/src') }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'mobile/www'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000
  }
})
