// Small models sometimes call a shell by name ("sh", "bash", "powershell", "terminal") instead of the
// run_command tool. Those calls become run_command, so the command runs (through the same approval
// rules) instead of failing with "no such tool". No imports, so tests/tool-alias.test.ts can check it.

const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'shell',
  'powershell',
  'pwsh',
  'cmd',
  'terminal',
  'exec',
  'execute',
  'run',
  'command',
  'runshell',
  'runbash',
  'runpowershell',
  'runterminal',
  'runterminalcommand',
  'shellcommand',
  'bashcommand',
  'executecommand',
  'runcmd',
  'execcommand'
])

/** Names small models make up for real tools ("system_information" for system_info). */
const SYNONYMS: Record<string, string> = {
  systeminformation: 'system_info',
  getsysteminfo: 'system_info',
  getsysteminformation: 'system_info',
  sysinfo: 'system_info',
  computerinfo: 'system_info',
  pcinfo: 'system_info',
  hardwareinfo: 'system_info',
  listfiles: 'list_dir',
  listdirectory: 'list_dir',
  listfolder: 'list_dir',
  ls: 'list_dir',
  dir: 'list_dir',
  readfiles: 'read_file',
  cat: 'read_file',
  openfile: 'read_file',
  createfile: 'write_file',
  savefile: 'write_file',
  findfiles: 'search_files',
  searchfile: 'search_files',
  findfile: 'search_files',
  largestfiles: 'search_files',
  websearch: 'web_search',
  searchweb: 'web_search',
  search: 'web_search',
  google: 'web_search',
  browse: 'read_webpage',
  fetchurl: 'read_webpage',
  openurl: 'read_webpage',
  fetch: 'read_webpage',
  screenshot: 'take_screenshot',
  processes: 'list_processes',
  getprocesses: 'list_processes',
  tasklist: 'list_processes',
  kill: 'kill_process',
  endprocess: 'kill_process',
  open: 'open_target',
  launch: 'open_target',
  startprogram: 'open_target',
  deletefile: 'delete_path',
  remove: 'delete_path',
  movefile: 'move_path',
  rename: 'move_path',
  copyfile: 'copy_path',
  mkdir: 'make_dir',
  createfolder: 'make_dir',
  createdirectory: 'make_dir',
  settings: 'maris_settings',
  getsettings: 'maris_settings',
  changesettings: 'change_maris_settings',
  setsetting: 'change_maris_settings'
}

/**
 * The real tool a made-up name means, or undefined: "system_tool_system_info" and "functions.read_file"
 * end with a real name, "system_information" is a known synonym, and "get_system_info" holds all the
 * words of one. `known` lists the tools of this chat.
 */
export function resolveToolName(name: string, known: string[]): string | undefined {
  if (known.includes(name)) return name
  const lower = name.toLowerCase().replace(/^(functions?|tools?)[.:]/, '')
  if (known.includes(lower)) return lower
  // Ends with a real name: "system_tool_system_info", "default_api.read_file".
  const suffix = known.filter((k) => lower.endsWith(`_${k}`) || lower.endsWith(`.${k}`)).sort((a, b) => b.length - a.length)[0]
  if (suffix) return suffix
  const syn = SYNONYMS[lower.replace(/[^a-z]/g, '')]
  if (syn && known.includes(syn)) return syn
  // All the words of a real name, in any order, and nothing that points elsewhere: "get_system_info".
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean))
  const hits = known.filter((k) => k.split('_').every((w) => words.has(w)) && k.split('_').length >= 2)
  return hits.length === 1 ? hits[0] : undefined
}

const COMMAND_KEYS =['command', 'cmd', 'script', 'code', 'input', 'commandLine', 'command_line', 'commands', 'args', 'arguments']

/** run_command arguments for a call to a shell-like tool name, or undefined when it is not one. */
export function shellAlias(name: string, args: Record<string, unknown>): { name: 'run_command'; args: Record<string, unknown> } | undefined {
  if (!SHELL_NAMES.has(name.toLowerCase().replace(/[^a-z]/g, ''))) return undefined
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? v.join('; ') : undefined)
  let command: string | undefined
  for (const k of COMMAND_KEYS) command ??= pick(args[k])
  command ??= Object.values(args).map(pick).find(Boolean)
  if (!command) return undefined
  return { name: 'run_command', args: { command, ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}) } }
}
