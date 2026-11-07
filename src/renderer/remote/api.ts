// The `maris` API for the phone app: the same shape as the desktop preload, carried over Maris Link.
import { API_CHANNELS } from '@shared/channels'
import type { Attachment } from '@shared/types'
import type { LinkClient } from './link'

const MAX_UPLOAD = 25 * 2 ** 20

/** Let the person choose files on the phone. */
function chooseFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])])
      input.remove()
    })
    // No change event when the picker is dismissed; the focus coming back tells us.
    window.addEventListener('focus', () => setTimeout(() => !input.files?.length && resolve([]), 800), { once: true })
    document.body.append(input)
    input.click()
  })
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
}

export function createRemoteApi(client: LinkClient): Record<string, unknown> {
  const api: Record<string, Record<string, unknown>> = {}
  for (const [group, members] of Object.entries(API_CHANNELS)) {
    api[group] = Object.fromEntries(
      Object.entries(members).map(([name, channel]) => [
        name,
        /^on[A-Z]/.test(name) ? (cb: (p: unknown) => void) => client.on(channel, cb) : (...args: unknown[]) => client.call(channel, args)
      ])
    )
  }

  const upload = async (files: File[]): Promise<Attachment[]> => {
    const out: Attachment[] = []
    for (const f of files.slice(0, 10)) {
      if (f.size > MAX_UPLOAD) throw new Error(`${f.name} is larger than 25 MB.`)
      out.push((await client.upload(f.name, await toBase64(f))) as Attachment)
    }
    return out
  }

  // Things that open dialogs or folders on the computer get a phone equivalent instead.
  api.files = {
    ...api.files,
    pick: async () => upload(await chooseFiles('*/*', true)),
    pickImage: async () => {
      const [img] = await upload(await chooseFiles('image/*', false))
      return img?.path
    },
    attach: async () => [],
    pathFor: () => ''
  }
  api.shell = {
    ...api.shell,
    openExternal: async (url: string) => {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener')
    },
    openPath: async () => '',
    showInFolder: async () => undefined
  }
  api.settings = {
    ...api.settings,
    pickFolder: async () => undefined,
    exportFile: async () => undefined,
    importFile: async () => undefined
  }
  api.project = {
    ...api.project,
    open: async (dir?: string) => {
      const target = dir ?? window.prompt(`Folder on ${client.pairing.hostName}, for example ${client.pairing.platform === 'win32' ? 'C:\\Users\\me\\Projects\\game' : '~/Projects/game'}`)?.trim()
      return target ? client.call('project:open', [target]) : undefined
    }
  }

  // Pictures and videos are fetched and decrypted on demand; the blob URLs are kept for the session.
  const blobs = new Map<string, Promise<string>>()
  const mediaBlob = (path: string): Promise<string> => {
    let p = blobs.get(path)
    if (!p) {
      p = client.media(path).then((b) => URL.createObjectURL(b))
      p.catch(() => blobs.delete(path))
      blobs.set(path, p)
    }
    return p
  }

  return { ...api, platform: client.pairing.platform, remote: true, hostName: client.pairing.hostName, mediaBlob }
}
