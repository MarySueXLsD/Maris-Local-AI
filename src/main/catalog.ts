import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CatalogModel, PullProgress } from '@shared/types'
import { LLM_CATALOG } from '@shared/models'
import { ollama } from './engines/ollama'
import { downloadAll, downloads } from './media/downloader'
import { settings } from './settings'
import { Emitter } from './util'

interface CustomBuild {
  files: { url: string; name: string; sizeBytes: number }[]
  modelfile: (paths: string[]) => string
}

type Entry = CatalogModel & { custom?: CustomBuild }

const QWEN38_Q3: CustomBuild = {
  files: [
    {
      url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q3_K_XL.gguf',
      name: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
      sizeBytes: 13146393504
    },
    {
      url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-BF16.gguf',
      name: 'mmproj-BF16.gguf',
      sizeBytes: 931146432
    }
  ],
  modelfile: ([gguf, mmproj]) =>
    [
      `FROM ${gguf}`,
      `FROM ${mmproj}`,
      'TEMPLATE {{ .Prompt }}',
      'RENDERER qwen3.8',
      'PARSER qwen3.5',
      'PARAMETER temperature 1',
      'PARAMETER top_k 20',
      'PARAMETER top_p 0.95',
      'PARAMETER min_p 0',
      'PARAMETER presence_penalty 0',
      'PARAMETER repeat_penalty 1'
    ].join('\n')
}

/** Models built locally from GGUF files instead of pulled from the Ollama library. */
const CUSTOM: Record<string, CustomBuild> = { 'qwen3.8:27b-q3': QWEN38_Q3 }

export const CATALOG: Entry[] = LLM_CATALOG.map((m) => (CUSTOM[m.name] ? { ...m, custom: CUSTOM[m.name] } : m))

export const isCatalogModel = (name: string): boolean => CATALOG.some((c) => c.name === name)

export const pulls = new Emitter<PullProgress>()
const controllers = new Map<string, AbortController>()

export async function installModel(name: string): Promise<void> {
  if (controllers.has(name)) return
  const ctrl = new AbortController()
  controllers.set(name, ctrl)
  try {
    const entry = CATALOG.find((c) => c.name === name)
    if (entry?.custom) {
      await buildCustom(name, entry.custom, ctrl.signal)
    } else {
      await ollama.pull(name, (p) => pulls.emit(p), ctrl.signal)
    }
  } catch (e) {
    pulls.emit({ model: name, status: 'error', done: true, error: ctrl.signal.aborted ? 'Cancelled' : (e as Error).message })
    throw e
  } finally {
    controllers.delete(name)
  }
}

export function cancelInstall(name: string): void {
  controllers.get(name)?.abort()
}

async function buildCustom(name: string, spec: CustomBuild, signal: AbortSignal): Promise<void> {
  const dir = path.join(settings.get().dataDir, 'llm-staging')
  const paths = spec.files.map((f) => path.join(dir, f.name))
  const off = downloads.on((d) => {
    if (d.id === `llm:${name}`) pulls.emit({ model: name, status: `downloading ${d.file ?? ''}`, completed: d.receivedBytes, total: d.totalBytes })
  })
  signal.addEventListener('abort', () => void import('./media/downloader').then((m) => m.cancelDownload(`llm:${name}`)))
  try {
    await downloadAll(
      `llm:${name}`,
      name,
      spec.files.map((f, i) => ({ url: f.url, dest: paths[i], sizeBytes: f.sizeBytes }))
    )
  } finally {
    off()
  }
  pulls.emit({ model: name, status: 'importing into Ollama' })
  const modelfile = path.join(dir, `${name.replace(/[^\w.-]/g, '_')}.Modelfile`)
  await fs.writeFile(modelfile, spec.modelfile(paths), 'ascii')
  const exe = ollama.cliPath() ?? 'ollama'
  await new Promise<void>((resolve, reject) => {
    const p = spawn(exe, ['create', name, '-f', modelfile], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ollama create failed: ${err.slice(-400)}`))))
  })
  for (const p of [...paths, modelfile]) await fs.rm(p, { force: true })
  pulls.emit({ model: name, status: 'success', done: true })
}
