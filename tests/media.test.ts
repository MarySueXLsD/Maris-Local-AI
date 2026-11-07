import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkflow, choosePack, fitSize } from '../src/main/media/catalog.ts'

test('small models get requests scaled to their native area, keeping the shape', () => {
  assert.deepEqual(fitSize('image-sd15', 1024, 1024), [512, 512])
  const [w, h] = fitSize('image-sd15', 1344, 768)
  assert.ok(Math.abs(w / h - 1344 / 768) < 0.05, `shape kept: ${w}×${h}`)
  assert.ok(w * h <= 512 * 512 * 1.1, `area near 512²: ${w}×${h}`)
  assert.deepEqual(fitSize('image-fast', 1024, 1024), [1024, 1024], 'big models are left alone')
  assert.deepEqual(fitSize('video-lite', 1280, 704), fitSize('video-lite', 1280, 704))
  const [vw, vh] = fitSize('video-lite', 1280, 704)
  assert.ok(vw * vh <= 832 * 480 * 1.15)
})

test('the pack chosen in setup wins when it is installed and can do the job', () => {
  const installed = new Set(['image-fast', 'image-lite', 'image-sd15', 'video-fast'])
  const roles = { imageFast: 'image-lite', imageQuality: 'image-fast' }
  assert.equal(choosePack({ kind: 'image', prompt: 'a cat' }, installed, 'idle', roles).packId, 'image-lite')
  assert.equal(choosePack({ kind: 'image', prompt: 'a cat', quality: 'quality' }, installed, 'idle', roles).packId, 'image-fast')
  // An assigned pack that is not installed falls back to ranking.
  assert.equal(choosePack({ kind: 'image', prompt: 'a cat' }, installed, 'idle', { imageFast: 'image-quality' }).packId, 'image-fast')
  // Animating a picture needs a pack with image input.
  assert.equal(choosePack({ kind: 'video', prompt: 'waves', inputImage: 'C:\\x.png' }, installed, 'idle', { videoFast: 'video-lite' }).packId, 'video-fast')
})

test('Stable Diffusion 1.5 uses a single checkpoint and its own size', () => {
  const wf = buildWorkflow('image-sd15', { kind: 'image', prompt: 'a lighthouse' })
  assert.equal(wf.width, 512)
  assert.ok(Object.values(wf.workflow).some((n) => n.class_type === 'CheckpointLoaderSimple'))
  const lite = buildWorkflow('video-lite', { kind: 'video', prompt: 'waves', seconds: 2 })
  assert.equal(lite.frames, 33)
  assert.equal(lite.fps, 16)
})
