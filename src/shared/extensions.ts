// Types for updates, news posts, skills and connectors, shared by the main process and the interface.

// ------------------------------------------------------------------ updates

export interface UpdateAsset {
  name: string
  url: string
  size: number
}

export interface UpdateInfo {
  version: string
  name: string
  /** Release notes (Markdown). */
  notes: string
  url: string
  publishedAt: string
  /** The installer for this system, when the release has one. */
  asset?: UpdateAsset
  /** SHA256SUMS files of the release: the download is checked against them before it is used. */
  checksums?: UpdateAsset[]
}

export interface UpdateState {
  current: string
  checking: boolean
  checkedAt?: number
  available?: UpdateInfo
  /** Download of the installer: 0..1, then the local file. */
  downloading?: number
  downloaded?: string
  /** The downloaded update was checked and can be installed (Restart and update). */
  ready?: boolean
  /** Maris just updated itself to this version (it was started by the update). */
  justUpdated?: string
  error?: string
  /** No internet, or the update source could not be reached. */
  offline?: boolean
}

// ------------------------------------------------------------------ news (blog posts)

export type NewsKind = 'news' | 'update' | 'tip'

/** One entry of news/index.json in the feed repository. */
export interface NewsEntry {
  id: string
  title: string
  kind: NewsKind
  /** ISO date of publishing. */
  date: string
  summary: string
  /** Markdown file, relative to the news folder (posts/<id>.md). */
  file: string
  /** Picture shown in the list, relative to the news folder. */
  cover?: string
  /** For release notes: the version they describe. */
  version?: string
  pinned?: boolean
  author?: string
  /** 'file': a Markdown file put straight into the news folder in git (not listed in index.json). */
  source?: 'file'
}

export interface NewsIndex {
  version: 1
  updated: string
  posts: NewsEntry[]
}

export interface NewsState {
  posts: (NewsEntry & { unread: boolean; coverPath?: string })[]
  fetchedAt?: number
  loading: boolean
  offline?: boolean
  error?: string
  unread: number
}

export interface NewsPostContent {
  entry: NewsEntry
  /** Markdown with pictures pointing at local cached copies. */
  body: string
}

// ------------------------------------------------------------------ admin

export interface AdminStatus {
  /** A GitHub token is saved on this computer. */
  hasToken: boolean
  /** GitHub account the token belongs to. */
  login?: string
  /** The token may write to the feed repository. */
  canPublish: boolean
  repo: string
  error?: string
}

export interface PostDraft {
  id?: string
  title: string
  kind: NewsKind
  summary: string
  body: string
  version?: string
  pinned?: boolean
  /** Pictures added in the editor: name (as used in the Markdown) → data URL. */
  images: { name: string; dataUrl: string }[]
  /** Which picture is the cover, by name. */
  cover?: string
}

// ------------------------------------------------------------------ skills

export interface SkillInfo {
  id: string
  name: string
  description: string
  /** Where it came from: a git URL or a folder. */
  source: string
  /** Folder on this computer. */
  dir: string
  enabled: boolean
  installedAt: number
  updatedAt?: number
  /** Files besides SKILL.md (scripts, references). */
  files: number
}

// ------------------------------------------------------------------ connectors

export type ConnectorTransport = 'http' | 'stdio'

export interface ConnectorField {
  key: string
  label: string
  /** Secrets are stored with the system keychain and never shown again. */
  secret?: boolean
  optional?: boolean
  placeholder?: string
  help?: string
  /** Where the value goes: an HTTP header, an environment variable, the address, the command, or NAME=value lines. */
  target: { header: string; prefix?: string } | { env: string } | { url: true } | { command: true } | { envList: true }
  /** Multi-line input (for NAME=value lines). */
  multiline?: boolean
  /** The shape a valid value has (checked before saving), and what to say when it does not match. */
  pattern?: string
  patternHint?: string
}

export interface ConnectorPreset {
  id: string
  name: string
  description: string
  transport: ConnectorTransport
  url?: string
  command?: string
  args?: string[]
  fields: ConnectorField[]
  /** Where to get the key. */
  docs?: string
  /** Needs Node.js (npx) on this computer. */
  needsNode?: boolean
  /** Every tool of this service only reads (for services that do not mark their tools themselves). */
  readOnly?: boolean
}

export interface ConnectorConfig {
  id: string
  preset?: string
  name: string
  transport: ConnectorTransport
  url?: string
  command?: string
  args?: string[]
  enabled: boolean
  /** Values of fields that are not secret (an address, a command), shown again when editing. */
  values: Record<string, string>
  /** Which secret fields have saved values (the values themselves stay in the main process). */
  savedFields: string[]
  createdAt: number
}

export interface ConnectorInfo extends ConnectorConfig {
  status: 'off' | 'connecting' | 'ready' | 'error'
  error?: string
  tools: { name: string; description: string; readOnly: boolean }[]
}
