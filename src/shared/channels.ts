// Every call and event between the app window and the main process, by group. The desktop preload
// and the phone app's link client build the same `maris` API from this list, so the two never drift.
// Names that start with "on" subscribe to an event; all others are calls that return a promise.
export const API_CHANNELS = {
  chat: {
    send: 'chat:send',
    stop: 'chat:stop',
    regenerate: 'chat:regenerate',
    edit: 'chat:edit',
    feedback: 'chat:feedback',
    approve: 'chat:approve',
    approvals: 'chat:approvals',
    autoEdits: 'chat:autoEdits',
    compact: 'chat:compact',
    previewRoute: 'chat:previewRoute',
    context: 'chat:context',
    undoAnswer: 'chat:undoAnswer',
    onEvent: 'chat:event'
  },
  approvals: {
    sessions: 'approvals:sessions',
    setSession: 'approvals:setSession',
    clearSessions: 'approvals:clearSessions',
    onSessions: 'approvals:sessions'
  },
  conv: {
    list: 'conv:list',
    get: 'conv:get',
    rename: 'conv:rename',
    pin: 'conv:pin',
    setModel: 'conv:setModel',
    remove: 'conv:delete',
    search: 'conv:search',
    running: 'conv:running',
    exportChat: 'conv:export',
    branch: 'conv:branch'
  },
  models: {
    list: 'models:list',
    catalog: 'models:catalog',
    pull: 'models:pull',
    cancelPull: 'models:cancelPull',
    remove: 'models:delete',
    unload: 'models:unload',
    details: 'models:details',
    ensureOllama: 'models:ensureOllama',
    ollamaInstalled: 'models:ollamaInstalled',
    onPull: 'models:pull'
  },
  system: {
    status: 'system:status',
    gpuPrograms: 'system:gpuPrograms',
    endProgram: 'system:endProgram',
    onStatus: 'system:status'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    pickFolder: 'settings:pickFolder',
    reset: 'settings:reset',
    exportFile: 'settings:export',
    importFile: 'settings:import',
    onChange: 'settings:changed'
  },
  setup: {
    scan: 'setup:scan',
    lastScan: 'setup:lastScan',
    catalog: 'setup:catalog',
    apply: 'setup:apply',
    progress: 'setup:progress',
    cancel: 'setup:cancel',
    skip: 'setup:skip',
    onProgress: 'setup:progress'
  },
  memory: {
    list: 'memory:list',
    add: 'memory:add',
    update: 'memory:update',
    remove: 'memory:delete',
    events: 'memory:events',
    learnNow: 'memory:learnNow',
    routeStats: 'memory:routeStats',
    resetRouting: 'memory:resetRouting',
    onChange: 'memory:changed',
    onEvent: 'memory:event'
  },
  cli: {
    status: 'cli:status',
    set: 'cli:set'
  },
  media: {
    packs: 'media:packs',
    installPack: 'media:installPack',
    removePack: 'media:removePack',
    cancelDownload: 'media:cancelDownload',
    comfyState: 'media:comfyState',
    installComfy: 'media:installComfy',
    startComfy: 'media:startComfy',
    stopComfy: 'media:stopComfy',
    generate: 'media:generate',
    cancel: 'media:cancel',
    switch: 'media:switch',
    jobs: 'media:jobs',
    gallery: 'media:gallery',
    remove: 'media:delete',
    outputsDir: 'media:outputsDir',
    onDownload: 'media:download',
    onComfy: 'media:comfy',
    onJob: 'media:job'
  },
  project: {
    list: 'project:list',
    open: 'project:open',
    remove: 'project:remove',
    update: 'project:update',
    forgetCommand: 'project:forgetCommand',
    files: 'project:files',
    readFile: 'project:readFile',
    revert: 'project:revert',
    devEnv: 'project:devEnv',
    installToolchain: 'project:installToolchain',
    create: 'project:create',
    suggestLocation: 'project:suggestLocation',
    watch: 'project:watch',
    onToolchain: 'project:toolchain',
    onChanged: 'project:changed'
  },
  processes: {
    list: 'processes:list',
    output: 'processes:output',
    stop: 'processes:stop'
  },
  files: {
    pick: 'files:pick',
    pickImage: 'files:pickImage',
    attach: 'files:attach',
    saveImage: 'files:saveImage',
    saveText: 'files:saveText'
  },
  shell: {
    openPath: 'shell:openPath',
    showInFolder: 'shell:showInFolder',
    openExternal: 'shell:openExternal',
    reveal: 'shell:reveal'
  },
  updates: {
    state: 'updates:state',
    check: 'updates:check',
    download: 'updates:download',
    install: 'updates:install',
    openRelease: 'updates:openRelease',
    onChange: 'updates:changed'
  },
  news: {
    state: 'news:state',
    refresh: 'news:refresh',
    post: 'news:post',
    markRead: 'news:markRead',
    onChange: 'news:changed'
  },
  admin: {
    status: 'admin:status',
    setToken: 'admin:setToken',
    clearToken: 'admin:clearToken',
    publish: 'admin:publish',
    remove: 'admin:remove',
    loadDraft: 'admin:loadDraft',
    index: 'admin:index'
  },
  skills: {
    list: 'skills:list',
    install: 'skills:install',
    update: 'skills:update',
    remove: 'skills:remove',
    setEnabled: 'skills:setEnabled',
    read: 'skills:read',
    pickFolder: 'skills:pickFolder',
    onChange: 'skills:changed'
  },
  connectors: {
    list: 'connectors:list',
    presets: 'connectors:presets',
    add: 'connectors:add',
    edit: 'connectors:edit',
    remove: 'connectors:remove',
    setEnabled: 'connectors:setEnabled',
    reconnect: 'connectors:reconnect',
    onChange: 'connectors:changed'
  },
  providers: {
    list: 'providers:list',
    presets: 'providers:presets',
    add: 'providers:add',
    edit: 'providers:edit',
    remove: 'providers:remove',
    setEnabled: 'providers:setEnabled',
    setPicked: 'providers:setPicked',
    refresh: 'providers:refresh',
    usage: 'providers:usage',
    clearUsage: 'providers:clearUsage',
    setPrice: 'providers:setPrice',
    refreshPrices: 'providers:refreshPrices',
    onChange: 'providers:changed'
  },
  link: {
    status: 'link:status',
    startPairing: 'link:startPairing',
    cancelPairing: 'link:cancelPairing',
    removeDevice: 'link:removeDevice',
    onStatus: 'link:status'
  },
  app: {
    info: 'app:info',
    onCommand: 'app:command'
  }
} as const

export type ApiGroup = keyof typeof API_CHANNELS
