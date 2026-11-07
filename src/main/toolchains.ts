import { IS_MAC, IS_WIN, linuxPackageManager } from './platform'
import { runShell } from './tools/shell'
import { registerInstallSizes } from './tools/installInfo'
import { Emitter } from './util'

export interface Toolchain {
  id: string
  label: string
  /** Line prefix in dev_environment output that tells whether it is installed. */
  probe: string
  languages: string
  command: string
  sizeHint: string
}

const W = (id: string, extra = ''): string =>
  `winget install --id ${id} -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity ${extra}`.trim()

const HAXELIB_LIBS = ['lime', 'openfl', 'flixel', 'flixel-addons', 'flixel-tools', 'hxcpp']

const WINDOWS: Toolchain[] = [
  { id: 'dotnet', label: '.NET 10 SDK', probe: 'dotnet', languages: 'C#', command: W('Microsoft.DotNet.SDK.10'), sizeHint: '≈250 MB' },
  {
    id: 'msvc',
    label: 'Visual Studio 2026 Build Tools (C++)',
    probe: 'msvc',
    languages: 'C++, also the Rust MSVC linker',
    command: W('Microsoft.VisualStudio.BuildTools', '--override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'),
    sizeHint: '≈4–7 GB'
  },
  { id: 'cmake', label: 'CMake', probe: 'cmake', languages: 'C++', command: W('Kitware.CMake'), sizeHint: '≈100 MB' },
  { id: 'llvm', label: 'LLVM (clang)', probe: 'clang', languages: 'C++', command: W('LLVM.LLVM'), sizeHint: '≈700 MB' },
  { id: 'haxe', label: 'Haxe', probe: 'haxe', languages: 'Haxe', command: W('HaxeFoundation.Haxe'), sizeHint: '≈60 MB' },
  {
    id: 'haxeflixel',
    label: 'HaxeFlixel (lime, openfl, flixel)',
    probe: 'haxelib',
    languages: 'HaxeFlixel games',
    command: `haxelib setup "$env:USERPROFILE\\haxelib" | Out-Null; foreach ($l in ${HAXELIB_LIBS.map((l) => `"${l}"`).join(',')}) { haxelib install $l --always --quiet }`,
    sizeHint: '≈300 MB'
  },
  { id: 'rust', label: 'Rust (rustup)', probe: 'cargo', languages: 'Rust', command: W('Rustlang.Rustup'), sizeHint: '≈300 MB' },
  { id: 'python', label: 'Python 3.13', probe: 'python', languages: 'Python', command: W('Python.Python.3.13'), sizeHint: '≈100 MB' },
  { id: 'node', label: 'Node.js LTS', probe: 'node', languages: 'JavaScript, TypeScript, web tooling', command: W('OpenJS.NodeJS.LTS'), sizeHint: '≈80 MB' }
]

// Installs that need no administrator password on macOS and Linux (they go into the home folder).
const RUSTUP = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path"
const DOTNET = 'curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir "$HOME/.dotnet"'
const HAXEFLIXEL_POSIX = `mkdir -p "$HOME/haxelib" && haxelib setup "$HOME/haxelib" >/dev/null && for l in ${HAXELIB_LIBS.join(' ')}; do haxelib install "$l" --always --quiet || exit 1; done`

/** Homebrew installs (macOS). Fails with a clear message when Homebrew itself is missing. */
const BREW = (formula: string): string =>
  `if ! command -v brew >/dev/null 2>&1; then echo "Homebrew is not installed. Install Homebrew first (the first item in this list)." >&2; exit 127; fi; brew install ${formula}`

const MAC: Toolchain[] = [
  {
    id: 'homebrew',
    label: 'Homebrew (package manager)',
    probe: 'brew',
    languages: 'needed for the installs below',
    // The official installer asks for your Mac password, so it opens in Terminal where you can type it.
    command: `osascript -e 'tell application "Terminal" to do script "/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\""' -e 'tell application "Terminal" to activate' && echo "Homebrew's installer opened in Terminal. Follow it there, then press Check again."`,
    sizeHint: '≈500 MB'
  },
  {
    id: 'xcode',
    label: 'Xcode Command Line Tools',
    probe: 'xcode',
    languages: 'C, C++, Swift compilers and git',
    command: 'xcode-select --install 2>&1; echo "A macOS window asks you to install the tools. Click Install there, then press Check again."',
    sizeHint: '≈1–2 GB'
  },
  { id: 'dotnet', label: '.NET 10 SDK', probe: 'dotnet', languages: 'C#', command: DOTNET, sizeHint: '≈250 MB' },
  { id: 'cmake', label: 'CMake', probe: 'cmake', languages: 'C++', command: BREW('cmake'), sizeHint: '≈60 MB' },
  { id: 'llvm', label: 'LLVM (clang)', probe: 'clang', languages: 'C++', command: BREW('llvm'), sizeHint: '≈1.5 GB' },
  { id: 'haxe', label: 'Haxe', probe: 'haxe', languages: 'Haxe', command: BREW('haxe'), sizeHint: '≈60 MB' },
  { id: 'haxeflixel', label: 'HaxeFlixel (lime, openfl, flixel)', probe: 'haxelib', languages: 'HaxeFlixel games', command: HAXEFLIXEL_POSIX, sizeHint: '≈300 MB' },
  { id: 'rust', label: 'Rust (rustup)', probe: 'cargo', languages: 'Rust', command: RUSTUP, sizeHint: '≈300 MB' },
  { id: 'python', label: 'Python 3.13', probe: 'python', languages: 'Python', command: BREW('python@3.13'), sizeHint: '≈100 MB' },
  { id: 'node', label: 'Node.js LTS', probe: 'node', languages: 'JavaScript, TypeScript, web tooling', command: BREW('node'), sizeHint: '≈80 MB' }
]

type Pm = 'apt' | 'dnf' | 'pacman' | 'zypper'
const PKG: Record<string, Record<Pm, string>> = {
  build: { apt: 'build-essential', dnf: 'gcc gcc-c++ make', pacman: 'base-devel', zypper: 'gcc gcc-c++ make' },
  cmake: { apt: 'cmake ninja-build', dnf: 'cmake ninja-build', pacman: 'cmake ninja', zypper: 'cmake ninja' },
  clang: { apt: 'clang lld', dnf: 'clang lld', pacman: 'clang lld', zypper: 'clang lld' },
  haxe: { apt: 'haxe', dnf: 'haxe', pacman: 'haxe', zypper: 'haxe' },
  python: { apt: 'python3 python3-venv python3-pip', dnf: 'python3 python3-pip', pacman: 'python python-pip', zypper: 'python3 python3-pip' },
  node: { apt: 'nodejs npm', dnf: 'nodejs npm', pacman: 'nodejs npm', zypper: 'nodejs npm' }
}

/** A system package install on Linux. pkexec shows the desktop's own password prompt. */
function linuxInstall(key: keyof typeof PKG): string {
  const pm = linuxPackageManager()
  if (!pm) return `echo "Could not find apt, dnf, pacman or zypper. Install ${PKG[key].apt} with your distribution's package manager." >&2; exit 127`
  const pkgs = PKG[key][pm]
  const cmd = {
    apt: `apt-get update && apt-get install -y ${pkgs}`,
    dnf: `dnf install -y ${pkgs}`,
    pacman: `pacman -S --needed --noconfirm ${pkgs}`,
    zypper: `zypper --non-interactive install ${pkgs}`
  }[pm]
  return `pkexec sh -c '${cmd}'`
}

const LINUX = (): Toolchain[] => [
  { id: 'build', label: 'C/C++ build tools (gcc, make)', probe: 'gcc', languages: 'C, C++, also needed by Rust and hxcpp', command: linuxInstall('build'), sizeHint: '≈200 MB' },
  { id: 'dotnet', label: '.NET 10 SDK', probe: 'dotnet', languages: 'C#', command: DOTNET, sizeHint: '≈250 MB' },
  { id: 'cmake', label: 'CMake and Ninja', probe: 'cmake', languages: 'C++', command: linuxInstall('cmake'), sizeHint: '≈40 MB' },
  { id: 'llvm', label: 'LLVM (clang)', probe: 'clang', languages: 'C++', command: linuxInstall('clang'), sizeHint: '≈300 MB' },
  { id: 'haxe', label: 'Haxe', probe: 'haxe', languages: 'Haxe', command: linuxInstall('haxe'), sizeHint: '≈60 MB' },
  { id: 'haxeflixel', label: 'HaxeFlixel (lime, openfl, flixel)', probe: 'haxelib', languages: 'HaxeFlixel games', command: HAXEFLIXEL_POSIX, sizeHint: '≈300 MB' },
  { id: 'rust', label: 'Rust (rustup)', probe: 'cargo', languages: 'Rust', command: RUSTUP, sizeHint: '≈300 MB' },
  { id: 'python', label: 'Python 3 with venv and pip', probe: 'python', languages: 'Python', command: linuxInstall('python'), sizeHint: '≈60 MB' },
  { id: 'node', label: 'Node.js and npm', probe: 'node', languages: 'JavaScript, TypeScript, web tooling', command: linuxInstall('node'), sizeHint: '≈80 MB' }
]

/** The toolchains Maris can install on this system. */
export const TOOLCHAINS: Toolchain[] = IS_WIN ? WINDOWS : IS_MAC ? MAC : LINUX()

// Approvals for installing these show their size (tools/installInfo.ts).
registerInstallSizes(TOOLCHAINS.flatMap((t) => {
  const id = /--id\s+(\S+)/.exec(t.command)?.[1]
  return id ? [[id, t.sizeHint] as [string, string]] : []
}))

export const toolchainEvents = new Emitter<{ id: string; status: 'running' | 'done' | 'error'; output?: string }>()
const running = new Set<string>()

/** Which toolchains look installed, from the dev_environment report text. */
export function parseInstalled(report: string, list: Toolchain[] = TOOLCHAINS): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const t of list) {
    const line = report.split('\n').find((l) => l.toLowerCase().startsWith(`${t.probe}:`))
    let ok = Boolean(line) && !/not installed/i.test(line!)
    if (t.id === 'dotnet') ok = ok && /\d+\.\d+\.\d+/.test(line ?? '')
    if (t.id === 'haxeflixel') ok = ok && /flixel/i.test(line ?? '')
    if (t.id === 'msvc') ok = ok && /C\+\+ tools at/i.test(line ?? '')
    out[t.id] = ok
  }
  return out
}

/** Install a toolchain. Only ever called from a button the user clicked. */
export async function installToolchain(id: string): Promise<string> {
  const t = TOOLCHAINS.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown toolchain ${id}`)
  if (running.has(id)) throw new Error('Already installing')
  running.add(id)
  toolchainEvents.emit({ id, status: 'running' })
  try {
    const r = await runShell(t.command, { timeoutMs: 45 * 60000 })
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-4000)
    const ok = r.code === 0 || /successfully installed|already installed|no available upgrade/i.test(output)
    toolchainEvents.emit({ id, status: ok ? 'done' : 'error', output })
    if (!ok) throw new Error(output.split('\n').filter(Boolean).slice(-3).join(' ') || `exit code ${r.code}`)
    return output
  } finally {
    running.delete(id)
  }
}
