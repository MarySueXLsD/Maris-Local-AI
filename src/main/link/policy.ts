// What the phone app may call over Maris Link. Every channel the desktop window can call is listed here,
// and a channel that is not listed stays on the computer: a handler added later is not reachable from a
// phone until someone decides it should be (tests/link-policy.test.ts checks that each one is listed).
// Kept free of imports so tests can load it directly.

/** 'phone': always. 'approve': only while "Approve changes from the phone" is on (it changes the computer). */
export type PhoneAccess = 'phone' | 'approve' | 'desktop'

const PHONE = [
  'chat:send',
  'chat:stop',
  'chat:regenerate',
  'chat:edit',
  'chat:feedback',
  'chat:compact',
  'chat:context',
  'chat:approvals',
  'chat:previewRoute',
  // Turning these on is checked separately (see phoneArgs): only "off" needs no right.
  'chat:autoEdits',
  'approvals:setSession',
  'approvals:sessions',
  'approvals:clearSessions',
  'conv:list',
  'conv:get',
  'conv:rename',
  'conv:pin',
  'conv:setModel',
  'conv:delete',
  'conv:search',
  'conv:running',
  'conv:export',
  'conv:branch',
  'models:list',
  'models:catalog',
  'models:cancelPull',
  'models:unload',
  'models:details',
  'models:ensureOllama',
  'models:ollamaInstalled',
  'system:status',
  'system:gpuPrograms',
  'settings:get',
  // Filtered by phoneSettingsPatch.
  'settings:set',
  'settings:reset',
  'setup:lastScan',
  'setup:catalog',
  'setup:progress',
  'memory:list',
  'memory:add',
  'memory:update',
  'memory:delete',
  'memory:events',
  'memory:learnNow',
  'memory:routeStats',
  'memory:resetRouting',
  'media:packs',
  'media:cancelDownload',
  'media:comfyState',
  'media:startComfy',
  'media:stopComfy',
  'media:generate',
  'media:cancel',
  'media:switch',
  'media:jobs',
  'media:gallery',
  'media:delete',
  'media:outputsDir',
  // Only with a folder: without one it opens a folder picker on the computer.
  'project:open',
  'project:list',
  'project:remove',
  'project:update',
  'project:forgetCommand',
  'project:files',
  'project:readFile',
  'project:devEnv',
  'project:suggestLocation',
  // The phone gets a watcher of its own, so it never moves the window's.
  'project:watch',
  'processes:list',
  'processes:output',
  'processes:stop',
  'files:saveImage',
  'updates:state',
  'updates:check',
  'news:state',
  'news:refresh',
  'news:post',
  'news:markRead',
  'skills:list',
  'skills:read',
  'skills:setEnabled',
  'connectors:list',
  'connectors:presets',
  'providers:list',
  'providers:presets',
  'providers:setEnabled',
  'providers:setPicked',
  'providers:usage',
  'providers:refreshPrices',
  'providers:refresh',
  'app:info'
]

/** Changes to the computer: programs that start or install, files that change, models that are fetched or removed. */
const APPROVE = [
  'chat:approve',
  'chat:undoAnswer',
  'project:revert',
  'project:installToolchain',
  'models:pull',
  'models:delete',
  'media:installPack',
  'media:removePack',
  'media:installComfy',
  'skills:install',
  'skills:update',
  'skills:remove',
  // A connector is a program that runs on the computer (a custom one runs any command).
  'connectors:add',
  'connectors:edit',
  'connectors:remove',
  'connectors:setEnabled',
  'connectors:reconnect'
]

/** Channels that stay on the computer: dialogs, the file manager, setup, updates, keys, the link and the Admin page. */
export const DESKTOP_ONLY = new Set([
  'settings:pickFolder',
  'settings:export',
  'settings:import',
  'setup:scan',
  'setup:apply',
  'setup:skip',
  'setup:cancel',
  'files:pick',
  'files:pickImage',
  'files:attach',
  // A save dialog on the computer: the phone saves exported chats itself.
  'files:saveText',
  'shell:openPath',
  'shell:showInFolder',
  'shell:reveal',
  'shell:openExternal',
  'project:create',
  'updates:download',
  'updates:install',
  'updates:openRelease',
  'system:endProgram',
  'skills:pickFolder',
  'providers:add',
  'providers:edit',
  'providers:remove',
  'providers:setPrice',
  'providers:clearUsage',
  'link:status',
  'link:startPairing',
  'link:cancelPairing',
  'link:removeDevice',
  'cli:status',
  'cli:set',
  'cli:show',
  'admin:status',
  'admin:setToken',
  'admin:clearToken',
  'admin:publish',
  'admin:remove',
  'admin:loadDraft',
  'admin:index'
])

const ACCESS = new Map<string, PhoneAccess>([...PHONE.map((c) => [c, 'phone'] as const), ...APPROVE.map((c) => [c, 'approve'] as const)])

/** Whether the phone app may call a channel. Channels nobody listed stay on the computer. */
export function phoneAccess(channel: string): PhoneAccess {
  return DESKTOP_ONLY.has(channel) ? 'desktop' : (ACCESS.get(channel) ?? 'desktop')
}

/** Every channel that has a decision, for the test that checks the window's handlers against this file. */
export const DECIDED = new Set([...ACCESS.keys(), ...DESKTOP_ONLY])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Only the switches in `o` that turn something off. */
const offOnly = (o: unknown): Record<string, unknown> => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => v === false)) : {})

/**
 * A settings change sent from the phone, without what it may not change. Never: the link itself, where
 * chats and pictures are sent (the Ollama and ComfyUI addresses), where data lives, ComfyUI's start
 * options and where updates come from. Without the right to approve: nothing that approves, gives full
 * control or starts connector programs, except switching those off.
 */
export function phoneSettingsPatch(patch: unknown, mayApprove: boolean): Record<string, unknown> {
  if (!isObj(patch)) return {}
  const { link: _link, ollamaUrl: _o, comfyUrl: _c, dataDir: _d, ...rest } = patch
  if (isObj(rest.updates)) {
    const { repo: _r, admin: _a, ...keep } = rest.updates
    rest.updates = keep
  }
  if (isObj(rest.media)) {
    const { extraArgs: _x, ...keep } = rest.media
    rest.media = keep
  }
  if (!mayApprove) {
    if (isObj(rest.agent)) {
      const agent = { ...rest.agent }
      if ('autoApprove' in agent) agent.autoApprove = offOnly(agent.autoApprove)
      if (agent.fullControl !== false) delete agent.fullControl
      rest.agent = agent
    }
    if (isObj(rest.extensions) && rest.extensions.connectors !== false) {
      const { connectors: _x, ...keep } = rest.extensions
      rest.extensions = keep
    }
  }
  return rest
}

/**
 * The arguments of a call from the phone, or why it is refused. Switching approvals on (for a session, or
 * for file edits in a Code project) needs the right to approve; switching them off never does.
 */
export function phoneArgs(channel: string, args: unknown[], mayApprove: boolean): { args: unknown[] } | { refused: string } {
  const noRight = 'Approving changes from the phone is turned off on the computer (Settings → Phone).'
  if (channel === 'settings:set') return { args: [phoneSettingsPatch(args[0], mayApprove)] }
  if (channel === 'settings:reset' && (args[0] === 'link' || args[0] === undefined)) return { refused: 'Not available from the phone' }
  if ((channel === 'approvals:setSession' || channel === 'chat:autoEdits') && args[1] === true && !mayApprove) return { refused: noRight }
  if (channel === 'project:open' && (typeof args[0] !== 'string' || !args[0])) return { refused: 'Open a project on the computer first; the phone can then pick it from the list.' }
  if (channel === 'project:watch') return { args: [args[0], 'phone'] }
  return { args }
}
