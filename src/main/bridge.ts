import { Emitter } from './util'

/** What the renderer can call, by IPC channel. Maris Link calls the same handlers for the phone app. */
export const handlers = new Map<string, (...args: unknown[]) => unknown>()

/** Every message sent to the app's windows, so Maris Link can pass it on to connected phones. */
export const outbound = new Emitter<{ channel: string; payload: unknown }>()
