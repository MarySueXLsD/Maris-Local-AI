import { existsSync } from 'node:fs'
import type { MediaJob, MediaParams } from '@shared/types'
import { comfy } from '../media/comfy'
import { media } from '../media/jobs'
import { resolvePath } from './paths'
import { num, schema, str, ToolError, type Args, type ToolContext, type ToolDef } from './types'

const ASPECTS: Record<string, [number, number]> = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832],
  wide: [1344, 768],
  tall: [768, 1344]
}
const VIDEO_ASPECTS: Record<string, [number, number]> = {
  wide: [1280, 704],
  landscape: [1280, 704],
  square: [960, 960],
  portrait: [704, 1280],
  tall: [704, 1280]
}

async function runMedia(kind: 'image' | 'video', args: Args, ctx: ToolContext): Promise<string> {
  const aspect = String(args.aspect ?? (kind === 'video' ? 'wide' : 'square'))
  const image = args.image_path ? resolvePath(String(args.image_path), ctx.cwd) : undefined
  if (image && !existsSync(image)) throw new ToolError(`Image not found: ${image}`)
  const quality = args.quality === 'quality' || args.quality === 'fast' ? args.quality : 'auto'
  let [w, h] = (kind === 'video' ? VIDEO_ASPECTS : ASPECTS)[aspect] ?? (kind === 'video' ? [1280, 704] : [1024, 1024])
  const params: MediaParams = {
    kind,
    prompt: str(args.prompt, 'prompt'),
    negative: args.negative ? String(args.negative) : undefined,
    quality,
    width: w,
    height: h,
    count: kind === 'image' ? Math.max(1, Math.min(4, num(args.count, 1))) : 1,
    seconds: kind === 'video' ? Math.max(1, Math.min(8, num(args.seconds, quality === 'quality' ? 5 : 3))) : undefined,
    inputImage: image,
    conversationId: ctx.conversationId,
    // Set by the composer's Image and Video modes when the person picked a model (not offered to models).
    packId: typeof args.pack === 'string' && args.pack ? args.pack : undefined
  }
  const show = (j: MediaJob, switchedTo?: string): void => {
    ctx.progress(`${j.step ?? j.status}${j.progress ? ` · ${Math.round(j.progress * 100)}%` : ''}`)
    ctx.setMedia({
      jobId: j.id,
      kind,
      packId: j.packId,
      model: j.model ?? j.packId,
      status: j.status,
      progress: j.progress,
      step: j.step,
      startedAt: j.startedAt ?? j.createdAt,
      etaSec: j.etaSec,
      expectedSec: j.expectedSec,
      alternatives: j.status === 'done' ? undefined : media.alternatives(j),
      switchedTo
    })
    if (ctx.signal.aborted) media.cancel(j.id)
  }
  // Stopping the answer (or deleting the chat) stops the picture at once, not at its next progress step.
  let current: string | undefined
  const onAbort = (): void => {
    if (current) media.cancel(current)
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const track = (j: MediaJob, switchedTo?: string): void => {
    current = j.id
    show(j, switchedTo)
  }
  // The person can move the job to another model from its card; it then starts again with that one.
  let job = await media.generate(params, (j) => track(j))
  for (let n = 0; n < 4 && job.status === 'cancelled' && media.switchedTo(job.id) && !ctx.signal.aborted; n++) {
    const next = media.switchedTo(job.id)!
    show(job, next)
    job = await media.generate({ ...params, packId: next }, (j) => track(j))
  }
  ctx.signal.removeEventListener('abort', onAbort)
  if (job.status === 'cancelled') throw new ToolError('The person stopped it before it was finished.')
  if (job.status !== 'done') throw new ToolError(job.error ?? `Generation ${job.status}`)
  for (const r of job.results) ctx.addMedia(r)
  w = job.results[0]?.width ?? w
  h = job.results[0]?.height ?? h
  return `Generated ${job.results.length} ${kind}${job.results.length > 1 ? 's' : ''} with ${job.reason} (${w}×${h}). Files: ${job.results
    .map((r) => r.path)
    .join(', ')}. The result is already shown to the user in the chat.`
}

export const mediaTools: ToolDef[] = [
  {
    name: 'generate_image',
    risk: 'heavy',
    enabled: () => comfy.isInstalled(),
    description:
      'Create images from a text description with a local image model (also useful for game sprites, textures, icons and concept art). Write a detailed English prompt: subject, setting, style, lighting, camera. quality "auto" lets the app pick a fast or a high-quality model.',
    parameters: schema(
      {
        prompt: { type: 'string', description: 'Detailed English description of the image' },
        negative: { type: 'string', description: 'Things to avoid (optional)' },
        aspect: { type: 'string', description: 'Shape of the image', enum: ['square', 'portrait', 'landscape', 'wide', 'tall'] },
        quality: { type: 'string', description: 'auto, fast (seconds) or quality (slower, more detail)', enum: ['auto', 'fast', 'quality'] },
        count: { type: 'integer', description: 'Number of variations, 1-4' }
      },
      ['prompt']
    ),
    async prepare(args) {
      return { risk: 'heavy', title: `Generate image: ${str(args.prompt, 'prompt').slice(0, 80)}` }
    },
    run: (args, ctx) => runMedia('image', args, ctx)
  },
  {
    name: 'generate_video',
    risk: 'heavy',
    enabled: () => comfy.isInstalled(),
    description:
      'Create a short video clip (1-8 seconds) from a text description, or animate an existing image (image_path). Takes minutes. Describe motion and camera movement in English.',
    parameters: schema(
      {
        prompt: { type: 'string', description: 'English description of the scene, motion and camera' },
        image_path: { type: 'string', description: 'Optional picture to animate (absolute path)' },
        seconds: { type: 'integer', description: 'Clip length in seconds (default 3 fast / 5 quality)' },
        aspect: { type: 'string', description: 'Shape', enum: ['wide', 'square', 'portrait'] },
        quality: { type: 'string', description: 'auto, fast or quality', enum: ['auto', 'fast', 'quality'] }
      },
      ['prompt']
    ),
    async prepare(args) {
      return { risk: 'heavy', title: `Generate video: ${str(args.prompt, 'prompt').slice(0, 80)}` }
    },
    run: (args, ctx) => runMedia('video', args, ctx)
  }
]
