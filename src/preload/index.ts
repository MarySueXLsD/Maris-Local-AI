import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_CHANNELS } from '@shared/channels'

const invoke =
  <R = unknown>(channel: string) =>
  (...args: unknown[]): Promise<R> =>
    ipcRenderer.invoke(channel, ...args) as Promise<R>

const on =
  (channel: string) =>
  (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }

const built = Object.fromEntries(
  Object.entries(API_CHANNELS).map(([group, members]) => [
    group,
    Object.fromEntries(Object.entries(members).map(([name, channel]) => [name, /^on[A-Z]/.test(name) ? on(channel) : invoke(channel)]))
  ])
) as Record<string, Record<string, unknown>>

const api = {
  ...built,
  /** The computer's operating system (the phone app reports the linked computer's). */
  platform: (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux') as 'win32' | 'darwin' | 'linux',
  /** True in the phone app, which talks to a computer over the network. */
  remote: false,
  files: { ...built.files, pathFor: (file: File): string => webUtils.getPathForFile(file) }
}

export type MarisBridge = typeof api

contextBridge.exposeInMainWorld('maris', api)
