// Builds the maris terminal command: the Node part (out/cli/maris.cjs) and, on Windows, the small
// launcher bin\maris.exe (out/cli-bin) compiled with the C# compiler that comes with Windows.
// Usage: node scripts/build-cli.cjs   (part of npm run build)
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '-c', 'vite.cli.config.ts', '--logLevel', 'warn'], {
  cwd: root,
  stdio: 'inherit'
})

if (process.platform === 'win32') {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const csc = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => existsSync(p))
  if (!csc) throw new Error('The C# compiler of .NET Framework 4 (csc.exe) was not found; it ships with Windows 10 and 11.')
  const outDir = path.join(root, 'out', 'cli-bin')
  mkdirSync(outDir, { recursive: true })
  // The launcher carries the app's version in its file details (Explorer → Properties → Details).
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version.replace(/[^0-9.].*$/, '')
  const versionFile = path.join(outDir, 'MarisVersion.cs')
  writeFileSync(versionFile, `static class MarisVersion { public const string Value = "${version}.0"; }\n`)
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      `/win32icon:${path.join(root, 'resources', 'icon.ico')}`,
      `/win32manifest:${path.join(root, 'resources', 'cli', 'maris.manifest')}`,
      `/out:${path.join(outDir, 'maris.exe')}`,
      path.join(root, 'resources', 'cli', 'MarisLauncher.cs'),
      versionFile
    ],
    { stdio: 'inherit' }
  )
  rmSync(versionFile, { force: true })
}
console.log('Built the maris terminal command.')
