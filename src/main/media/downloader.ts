import { createWriteStream, existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadProgress } from '@shared/types'
import { Emitter, log } from '../util'

export const downloads = new Emitter<DownloadProgress>()
const active = new Map<string, AbortController>()

export interface DownloadItem {
  url: string
  dest: string
  sizeBytes?: number
}

/** Download a list of files with resume support; emits aggregate progress under one id. */
export async function downloadAll(id: string, label: string, items: DownloadItem[]): Promise<void> {
  if (active.has(id)) throw new Error('Already downloading')
  const ctrl = new AbortController()
  active.set(id, ctrl)
  const total = items.reduce((s, i) => s + (i.sizeBytes ?? 0), 0)
  let doneBytes = 0
  try {
    for (const item of items) {
      if (existsSync(item.dest) && (!item.sizeBytes || statSync(item.dest).size === item.sizeBytes)) {
        doneBytes += item.sizeBytes ?? statSync(item.dest).size
        downloads.emit({ id, label, receivedBytes: doneBytes, totalBytes: total, file: path.basename(item.dest) })
        continue
      }
      await downloadOne(item, ctrl.signal, (received) =>
        downloads.emit({
          id,
          label,
          receivedBytes: doneBytes + received,
          totalBytes: total,
          file: path.basename(item.dest)
        })
      )
      doneBytes += item.sizeBytes ?? statSync(item.dest).size
    }
    downloads.emit({ id, label, receivedBytes: total, totalBytes: total, done: true })
  } catch (e) {
    const msg = ctrl.signal.aborted ? 'Cancelled' : (e as Error).message
    downloads.emit({ id, label, receivedBytes: doneBytes, totalBytes: total, done: true, error: msg })
    throw e
  } finally {
    active.delete(id)
  }
}

export function cancelDownload(id: string): boolean {
  const c = active.get(id)
  if (!c) return false
  c.abort()
  return true
}

export const isDownloading = (id: string): boolean => active.has(id)

/** Ids of the downloads running now (model packs, engines). */
export const activeDownloads = (): string[] => [...active.keys()]

async function downloadOne(item: DownloadItem, signal: AbortSignal, onProgress: (received: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(item.dest), { recursive: true })
  const part = `${item.dest}.part`
  for (let attempt = 1; attempt <= 6; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0
    try {
      const res = await fetch(item.url, {
        headers: have ? { Range: `bytes=${have}-` } : {},
        signal,
        redirect: 'follow'
      })
      if (res.status === 416 && item.sizeBytes && have === item.sizeBytes) break
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${path.basename(item.dest)}`)
      const resumed = res.status === 206
      let received = resumed ? have : 0
      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
      let last = 0
      const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      src.on('data', (chunk: Buffer) => {
        received += chunk.length
        const now = Date.now()
        if (now - last > 400) {
          last = now
          onProgress(received)
        }
      })
      await pipeline(src, out)
      onProgress(received)
      if (item.sizeBytes && statSync(part).size < item.sizeBytes) throw new Error('Connection dropped')
      break
    } catch (e) {
      if (signal.aborted) throw e
      log.warn('download', `attempt ${attempt} failed for ${item.url}`, e)
      if (attempt === 6) throw e
      await new Promise((r) => setTimeout(r, attempt * 2000))
    }
  }
  await fs.rename(part, item.dest)
}
