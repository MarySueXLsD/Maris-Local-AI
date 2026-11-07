import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alsoEndsFor, displayName, groupGpuPrograms, isSystemProcess, parseSmiProcesses, pidFromInstance, scriptOf, type RawProc } from '../src/main/system/gpuPure.ts'

const procs = (list: RawProc[]): Map<number, RawProc> => new Map(list.map((p) => [p.pid, p]))
const mem = (list: [number, number][]): Map<number, number> => new Map(list)

/** A Windows desktop like the one Maris was built on, with programs and system parts using video memory. */
const DESKTOP = procs([
  { pid: 4, ppid: 0, name: 'System', session: 0 },
  { pid: 700, ppid: 600, name: 'winlogon.exe', session: 2, path: 'C:\\Windows\\System32\\winlogon.exe' },
  { pid: 701, ppid: 700, name: 'dwm.exe', session: 2, path: 'C:\\Windows\\System32\\dwm.exe' },
  { pid: 800, ppid: 1, name: 'explorer.exe', session: 2, path: 'C:\\Windows\\explorer.exe' },
  // Chrome: the GPU process is a child of the main chrome.exe, which explorer started.
  { pid: 1000, ppid: 800, name: 'chrome.exe', session: 2, path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', description: 'Google Chrome' },
  { pid: 1001, ppid: 1000, name: 'chrome.exe', session: 2, path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', description: 'Google Chrome', cmd: 'chrome.exe --type=gpu-process' },
  // Teams draws in a web view: its memory counts toward Teams.
  { pid: 1100, ppid: 800, name: 'ms-teams.exe', session: 2, description: 'Microsoft Teams' },
  { pid: 1101, ppid: 1100, name: 'msedgewebview2.exe', session: 2, description: 'Microsoft Edge WebView2' },
  { pid: 1102, ppid: 1101, name: 'msedgewebview2.exe', session: 2, description: 'Microsoft Edge WebView2' },
  // Two Python programs started from a terminal, one by another Python program.
  { pid: 1200, ppid: 800, name: 'WindowsTerminal.exe', session: 2 },
  { pid: 1201, ppid: 1200, name: 'python.exe', session: 2, cmd: 'python -u gen_pistol.py --seed 4', description: 'Python' },
  { pid: 1202, ppid: 1201, name: 'python.exe', session: 2, cmd: 'C:\\Python312\\python.exe "C:\\work\\train lora.py"', description: 'Python' },
  // A game that names itself oddly.
  { pid: 1300, ppid: 800, name: 'eden.exe', session: 2, description: '1.0.0.0' },
  // Maris, Ollama's model runner and ComfyUI.
  { pid: 2000, ppid: 800, name: 'Maris.exe', session: 2 },
  { pid: 2001, ppid: 2000, name: 'Maris.exe', session: 2 },
  { pid: 2100, ppid: 800, name: 'ollama app.exe', session: 2 },
  { pid: 2101, ppid: 2100, name: 'ollama.exe', session: 2 },
  { pid: 2102, ppid: 2101, name: 'llama-server.exe', session: 2 },
  { pid: 2200, ppid: 2000, name: 'python.exe', session: 2, path: 'D:\\Maris\\comfyui\\python_embeded\\python.exe', cmd: 'python.exe -s ComfyUI\\main.py' },
  // A service in session 0.
  { pid: 3000, ppid: 500, name: 'SomeService.exe', session: 0 }
])

const OPTS = { ownPids: new Set([2000, 2001]), mySession: 2, enginePaths: ['D:\\Maris\\comfyui\\python_embeded\\python.exe'], platform: 'win32' as const }

test("a browser's GPU helper counts toward the browser, and ending it means its main process", () => {
  const g = groupGpuPrograms(mem([[1001, 900]]), DESKTOP, OPTS)
  assert.deepEqual(g.programs, [{ pid: 1000, name: 'Google Chrome', exe: 'chrome.exe', vramMB: 900 }])
})

test('a web view counts toward the app it is part of', () => {
  const g = groupGpuPrograms(mem([[1102, 300]]), DESKTOP, OPTS)
  assert.equal(g.programs[0]?.pid, 1100)
  assert.equal(g.programs[0]?.name, 'Microsoft Teams')
})

test('Python programs stay separate and show their script', () => {
  const g = groupGpuPrograms(mem([[1201, 2000], [1202, 3000]]), DESKTOP, OPTS)
  assert.deepEqual(
    g.programs.map((p) => [p.pid, p.detail, p.vramMB]),
    [
      [1202, 'train lora.py', 3000],
      [1201, 'gen_pistol.py', 2000]
    ]
  )
})

test("Maris's own memory (its window, Ollama's runner, ComfyUI) is not in the list", () => {
  const g = groupGpuPrograms(mem([[2001, 190], [2102, 3200], [2200, 5000], [1300, 8000]]), DESKTOP, OPTS)
  assert.deepEqual(g.programs.map((p) => p.exe), ['eden.exe'])
  assert.equal(g.marisMB, 190 + 3200 + 5000)
})

test('parts of Windows are summed up, never offered for ending', () => {
  const g = groupGpuPrograms(mem([[701, 2500], [800, 200], [4, 10], [3000, 100], [1300, 8000]]), DESKTOP, OPTS)
  assert.deepEqual(g.programs.map((p) => p.exe), ['eden.exe'])
  assert.equal(g.system.vramMB, 2810)
  assert.deepEqual(g.system.names.slice(0, 2), ['dwm.exe', 'explorer.exe'])
})

test('a program with a version number for a description shows its file name', () => {
  const g = groupGpuPrograms(mem([[1300, 8000]]), DESKTOP, OPTS)
  assert.equal(g.programs[0]?.name, 'eden')
  assert.equal(displayName({ pid: 1, ppid: 0, name: 'Discord.exe', description: 'Discord' }), 'Discord')
  assert.equal(displayName({ pid: 1, ppid: 0, name: 'tool.exe', description: 'A very long sentence that describes this tool in far too many words' }), 'tool')
})

test('a process that ended since the reading is skipped', () => {
  const g = groupGpuPrograms(mem([[99999, 500], [1001, 100]]), DESKTOP, OPTS)
  assert.deepEqual(g.programs.map((p) => p.pid), [1000])
})

test('another session or a service is part of the system', () => {
  assert.equal(isSystemProcess({ pid: 1, ppid: 0, name: 'game.exe', session: 3 }, { mySession: 2, platform: 'win32' }), true)
  assert.equal(isSystemProcess({ pid: 1, ppid: 0, name: 'game.exe', session: 2 }, { mySession: 2, platform: 'win32' }), false)
  assert.equal(isSystemProcess({ pid: 1, ppid: 0, name: 'notepad.exe', session: 2, path: 'C:\\Windows\\System32\\notepad.exe' }, { mySession: 2, platform: 'win32' }), true)
  assert.equal(isSystemProcess({ pid: 1, ppid: 0, name: 'Xorg', session: 0 }, { mySession: 1000, platform: 'linux' }), true)
  assert.equal(isSystemProcess({ pid: 1, ppid: 0, name: 'blender', session: 1000 }, { mySession: 1000, platform: 'linux' }), false)
})

test('scripts and modules a runtime runs', () => {
  assert.equal(scriptOf('python.exe -u gen_pistol.py --seed 4'), 'gen_pistol.py')
  assert.equal(scriptOf('"C:\\Python312\\python.exe" -m torch.distributed.run train.py'), '-m torch.distributed.run')
  assert.equal(scriptOf('node C:\\work\\server.mjs --port 3000'), 'server.mjs')
  assert.equal(scriptOf('java -Xmx4g -jar C:\\mc\\server.jar nogui'), 'server.jar')
  assert.equal(scriptOf('python.exe'), undefined)
  assert.equal(scriptOf(undefined), undefined)
})

test('nvidia-smi process tables, with and without GI/CI columns', () => {
  const newer = `
+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI        PID   Type   Process name                              GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|    0   N/A  N/A      1234      G   /usr/lib/xorg/Xorg                            256MiB |
|    0   N/A  N/A      5678      C   python3                                      4096MiB |
|    0   N/A  N/A      9012    C+G   /opt/blender/blender                          900MiB |
+-----------------------------------------------------------------------------------------+`
  assert.deepEqual(parseSmiProcesses(newer), [
    { pid: 1234, name: '/usr/lib/xorg/Xorg', mb: 256 },
    { pid: 5678, name: 'python3', mb: 4096 },
    { pid: 9012, name: '/opt/blender/blender', mb: 900 }
  ])
  const older = '|    0      4321      G   /usr/bin/gnome-shell                          120MiB |'
  assert.deepEqual(parseSmiProcesses(older), [{ pid: 4321, name: '/usr/bin/gnome-shell', mb: 120 }])
  // Windows: the memory column says N/A, which is not a reading.
  assert.deepEqual(parseSmiProcesses('|    0   N/A  N/A      1000    C+G   ...ome\\Application\\chrome.exe      N/A      |'), [])
})

test('performance counter names carry the process id', () => {
  assert.equal(pidFromInstance('pid_1234_luid_0x00000000_0x0000D1C6_phys_0'), 1234)
  assert.equal(pidFromInstance('_Total'), undefined)
})

test('the confirmation names the other programs that end with it, not its own helpers', () => {
  const all = [
    { pid: 10, ppid: 1, name: 'EpicGamesLauncher.exe', created: 1000 },
    { pid: 11, ppid: 10, name: 'EpicGamesLauncher.exe', created: 1001 },
    { pid: 12, ppid: 10, name: 'FortniteClient-Win64-Shipping.exe', created: 2000 },
    { pid: 13, ppid: 12, name: 'conhost.exe', created: 2001 },
    { pid: 14, ppid: 12, name: 'EasyAntiCheat.exe', created: 2002 },
    // Started before the launcher: its parent number was reused, so it is not the launcher's.
    { pid: 15, ppid: 10, name: 'OldTool.exe', created: 500 },
    { pid: 16, ppid: 1, name: 'Unrelated.exe', created: 3000 }
  ]
  assert.deepEqual(alsoEndsFor(10, all), ['EasyAntiCheat.exe', 'FortniteClient-Win64-Shipping.exe'])
  assert.deepEqual(alsoEndsFor(16, all), [])
  assert.deepEqual(alsoEndsFor(99, all), [])
  const g = groupGpuPrograms(mem([[1300, 8000]]), DESKTOP, OPTS, [
    { pid: 1300, ppid: 800, name: 'eden.exe', created: 100 },
    { pid: 1310, ppid: 1300, name: 'python.exe', created: 200 }
  ])
  assert.deepEqual(g.programs[0]?.alsoEnds, ['python.exe'])
})
