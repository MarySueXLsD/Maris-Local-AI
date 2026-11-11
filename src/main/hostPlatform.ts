// Modules shared with the window (the settings schema, chat descriptions) read the OS from the preload
// bridge, globalThis.maris.platform, and assume Windows without it. The main process has no bridge, so
// give it the same fact; imported first by src/main/index.ts.
// The Help articles are shared too (the assistant reads them): there the keyboard is this computer's.
const g = globalThis as { maris?: { platform?: string; macKeys?: boolean } }
g.maris ??= { platform: process.platform, macKeys: process.platform === 'darwin' }

export {}
