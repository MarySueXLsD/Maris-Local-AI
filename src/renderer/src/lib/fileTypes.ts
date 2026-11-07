import {
  Binary,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon
} from 'lucide-react'

export interface FileVisual {
  Icon: LucideIcon
  /** A colour that reads on both light and dark backgrounds. */
  color: string
  /** What the file is, in a word or two. */
  label: string
  /** highlight.js language for the file viewer. */
  lang?: string
}

const T = (Icon: LucideIcon, color: string, label: string, lang?: string): FileVisual => ({ Icon, color, label, lang })

const BY_EXT: Record<string, FileVisual> = {}
const add = (exts: string, v: FileVisual): void => {
  for (const e of exts.split(' ')) BY_EXT[e] = v
}
add('png jpg jpeg gif webp bmp ico tga psd avif heic', T(FileImage, '#c26de8', 'Picture'))
add('svg', T(FileImage, '#e8a33c', 'Vector picture', 'xml'))
add('mp4 mov webm mkv avi m4v', T(FileVideo, '#e05d8f', 'Video'))
add('mp3 wav ogg flac m4a aac', T(FileAudio, '#e0a63a', 'Sound'))
add('py pyw pyi', T(FileCode2, '#4b8bbe', 'Python', 'python'))
add('ipynb', T(FileCode2, '#f37726', 'Notebook', 'json'))
add('js mjs cjs', T(FileCode2, '#d9b52c', 'JavaScript', 'javascript'))
add('jsx', T(FileCode2, '#5ac8e8', 'React', 'javascript'))
add('ts mts cts', T(FileCode2, '#3f84d6', 'TypeScript', 'typescript'))
add('tsx', T(FileCode2, '#3f9fd6', 'React', 'typescript'))
add('rs', T(FileCode2, '#d9875a', 'Rust', 'rust'))
add('go', T(FileCode2, '#00add8', 'Go', 'go'))
add('cs', T(FileCode2, '#9b6bd6', 'C#', 'csharp'))
add('c h', T(FileCode2, '#6c8ebf', 'C', 'c'))
add('cpp cc cxx hpp hh hxx', T(FileCode2, '#659ad2', 'C++', 'cpp'))
add('java', T(FileCode2, '#e76f00', 'Java', 'java'))
add('kt kts', T(FileCode2, '#a97bff', 'Kotlin', 'kotlin'))
add('hx hxml', T(FileCode2, '#ea8220', 'Haxe'))
add('lua', T(FileCode2, '#5a7fd6', 'Lua', 'lua'))
add('php', T(FileCode2, '#8892bf', 'PHP', 'php'))
add('rb', T(FileCode2, '#cc4b45', 'Ruby', 'ruby'))
add('swift', T(FileCode2, '#f05138', 'Swift', 'swift'))
add('glsl hlsl shader frag vert wgsl', T(FileCode2, '#5bb08a', 'Shader', 'cpp'))
add('html htm', T(FileCode2, '#e2582f', 'Web page', 'xml'))
add('css', T(FileCode2, '#4f86e8', 'Styles', 'css'))
add('scss sass less', T(FileCode2, '#c76494', 'Styles', 'scss'))
add('vue svelte', T(FileCode2, '#41b883', 'Component', 'xml'))
add('json jsonc json5', T(FileJson, '#c9a227', 'JSON', 'json'))
add('xml csproj vcxproj props targets resx xaml plist', T(FileCode2, '#e37933', 'XML', 'xml'))
add('yml yaml', T(FileCog, '#cb4b5f', 'YAML', 'yaml'))
add('toml ini cfg conf env editorconfig properties', T(FileCog, '#8f89ad', 'Settings', 'ini'))
add('csv tsv xlsx xls ods', T(FileSpreadsheet, '#3fa75a', 'Table', 'plaintext'))
add('md markdown mdx', T(FileText, '#5ba4e6', 'Markdown', 'markdown'))
add('txt log', T(FileText, '#9aa0b4', 'Text', 'plaintext'))
add('rtf doc docx odt', T(FileText, '#3b7fd4', 'Document'))
add('pdf', T(FileText, '#e5484d', 'PDF'))
add('ps1 psm1 psd1', T(FileTerminal, '#4c8fd8', 'PowerShell', 'powershell'))
add('sh bash zsh fish', T(FileTerminal, '#5cab3c', 'Shell script', 'bash'))
add('bat cmd', T(FileTerminal, '#a8adbd', 'Batch script', 'dos'))
add('sql sqlite db', T(FileCog, '#d08f3c', 'Database', 'sql'))
add('zip 7z rar tar gz tgz bz2 xz', T(FileArchive, '#b08850', 'Archive'))
add('exe dll so dylib bin msi appimage apk', T(Binary, '#8a8fa3', 'Program'))
add('ttf otf woff woff2', T(FileType, '#a0a6b8', 'Font'))
add('lock', T(FileCog, '#8a8fa3', 'Lock file', 'plaintext'))

const BY_NAME: Record<string, FileVisual> = {
  dockerfile: T(FileCog, '#2496ed', 'Docker', 'dockerfile'),
  makefile: T(FileTerminal, '#6d8b3c', 'Makefile', 'makefile'),
  '.gitignore': T(FileCog, '#f05033', 'Git settings', 'plaintext'),
  '.gitattributes': T(FileCog, '#f05033', 'Git settings', 'plaintext'),
  'cmakelists.txt': T(FileCog, '#3e8ed0', 'CMake', 'cmake'),
  license: T(FileText, '#9aa0b4', 'Licence', 'plaintext'),
  readme: T(FileText, '#5ba4e6', 'Read me', 'plaintext')
}

const PLAIN = T(File, 'var(--text-3)', 'File')

export function fileVisual(name: string): FileVisual {
  const lower = name.toLowerCase()
  if (BY_NAME[lower]) return BY_NAME[lower]
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  return BY_EXT[ext] ?? PLAIN
}
