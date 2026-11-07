import type { MediaPack, MediaPackFile, MediaParams, MediaRole } from '@shared/types'

// Kept free of runtime imports so tests/workflows.mjs can load it directly with Node.

const HF = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`

const ZT = 'Comfy-Org/Z-Image-Turbo'
const ZB = 'Comfy-Org/Z-Image'
const WAN = 'Comfy-Org/Wan-2.2'
const WAN21 = 'Comfy-Org/Wan-2.1'
const SD15 = 'Comfy-Org/stable-diffusion-1.5'

const F = {
  zTurbo: { url: HF(ZT, 'split_files/diffusion_models/z_image_turbo_bf16.safetensors'), dir: 'diffusion_models', name: 'z_image_turbo_bf16.safetensors', sizeBytes: 12309866400 },
  zTurboInt8: { url: HF(ZT, 'split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors'), dir: 'diffusion_models', name: 'z_image_turbo_int8_convrot.safetensors', sizeBytes: 6201001296 },
  zBase: { url: HF(ZB, 'split_files/diffusion_models/z_image_bf16.safetensors'), dir: 'diffusion_models', name: 'z_image_bf16.safetensors', sizeBytes: 12309866400 },
  qwen4b: { url: HF(ZT, 'split_files/text_encoders/qwen_3_4b.safetensors'), dir: 'text_encoders', name: 'qwen_3_4b.safetensors', sizeBytes: 8044982048 },
  qwen4bFp8: { url: HF(ZT, 'split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors'), dir: 'text_encoders', name: 'qwen_3_4b_fp8_mixed.safetensors', sizeBytes: 5631994051 },
  sd15: { url: HF(SD15, 'v1-5-pruned-emaonly-fp16.safetensors'), dir: 'checkpoints', name: 'v1-5-pruned-emaonly-fp16.safetensors', sizeBytes: 2132696762 },
  wan13b: { url: HF(WAN21, 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors'), dir: 'diffusion_models', name: 'wan2.1_t2v_1.3B_fp16.safetensors', sizeBytes: 2838303560 },
  fluxAe: { url: HF(ZT, 'split_files/vae/ae.safetensors'), dir: 'vae', name: 'ae.safetensors', sizeBytes: 335304388 },
  wan5b: { url: HF(WAN, 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'), dir: 'diffusion_models', name: 'wan2.2_ti2v_5B_fp16.safetensors', sizeBytes: 9999658848 },
  umt5: { url: HF(WAN, 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'), dir: 'text_encoders', name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', sizeBytes: 6735906897 },
  wan22Vae: { url: HF(WAN, 'split_files/vae/wan2.2_vae.safetensors'), dir: 'vae', name: 'wan2.2_vae.safetensors', sizeBytes: 1409400960 },
  wan21Vae: { url: HF(WAN, 'split_files/vae/wan_2.1_vae.safetensors'), dir: 'vae', name: 'wan_2.1_vae.safetensors', sizeBytes: 253815318 },
  t2vHigh: { url: HF(WAN, 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'), dir: 'diffusion_models', name: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors', sizeBytes: 14293923632 },
  t2vLow: { url: HF(WAN, 'split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors'), dir: 'diffusion_models', name: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors', sizeBytes: 14293923632 },
  t2vLoraHigh: { url: HF(WAN, 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors'), dir: 'loras', name: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors', sizeBytes: 1226977424 },
  t2vLoraLow: { url: HF(WAN, 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors'), dir: 'loras', name: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors', sizeBytes: 1226977424 },
  i2vHigh: { url: HF(WAN, 'split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'), dir: 'diffusion_models', name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', sizeBytes: 14294742832 },
  i2vLow: { url: HF(WAN, 'split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'), dir: 'diffusion_models', name: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', sizeBytes: 14294742832 },
  i2vLoraHigh: { url: HF(WAN, 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'), dir: 'loras', name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', sizeBytes: 1226977424 },
  i2vLoraLow: { url: HF(WAN, 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'), dir: 'loras', name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', sizeBytes: 1226977424 }
} satisfies Record<string, MediaPackFile>

type PackDef = Omit<MediaPack, 'installed' | 'sizeGB'> & { order: number; supportsImageInput: boolean }

export const PACKS: PackDef[] = [
  {
    id: 'image-fast',
    details: {
      maker: 'Tongyi Lab (Alibaba)',
      size: '6 billion parameters, with Qwen3 4B reading the prompt',
      output: 'Pictures up to about 2 megapixels in any shape (1024×1024 by default)',
      how: 'A distilled version of Z-Image that needs only 8 steps and no guidance, which is why it is so quick.',
      goodAt: ['Photographs that look real: people, products, food, places', 'Following long, detailed prompts closely', 'Short text in the picture (signs, posters, labels), in English and Chinese'],
      weakAt: ['Less variety: the same prompt tends to give similar pictures', 'No “things to avoid” prompt (it ignores negative prompts)', 'Busy scenes with many small people or hands up close'],
      tips: ['Describe the subject, the setting, the light and the camera, in full sentences', 'Put text you want in the picture in quotes, for example a sign that says "OPEN"', 'For a different take, change the wording rather than only the seed'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo'
    },
    order: 1,
    kind: 'image',
    tier: 'fast',
    name: 'Z-Image Turbo',
    description: 'Photorealistic 6B model distilled to 8 steps. A 1024×1024 picture in a few seconds. Great default.',
    vramGB: 14,
    vramMinGB: 6,
    cpuOk: false,
    quality: 85,
    refSeconds: 6,
    unit: 'image',
    license: 'Apache-2.0',
    speed: '≈3–6 s per image',
    supportsImageInput: false,
    files: [F.zTurbo, F.qwen4b, F.fluxAe]
  },
  {
    id: 'image-lite',
    details: {
      maker: 'Tongyi Lab (Alibaba); 8-bit packaging by Comfy-Org',
      size: '6 billion parameters stored in 8 bits, with an 8-bit Qwen3 4B prompt reader',
      output: 'Pictures up to about 2 megapixels in any shape (1024×1024 by default)',
      how: 'The same 8-step Turbo model, with its weights stored at half the size so it fits graphics cards with 8 GB.',
      goodAt: ['Nearly everything Turbo is good at, on cards with 8 GB of video memory', 'Photographs that look real, and short text in pictures'],
      weakAt: ['Fine detail and text can be a little softer than full Turbo', 'Like Turbo: little variety between pictures, no negative prompt'],
      tips: ['Write prompts as you would for Turbo: subject, setting, light, camera', 'If your card has 12 GB or more, full Turbo gives slightly crisper results'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Comfy-Org/Z-Image-Turbo'
    },
    order: 2,
    kind: 'image',
    tier: 'fast',
    name: 'Z-Image Turbo Lite',
    description: 'The same Turbo model stored in 8-bit with a lighter text encoder, so it runs fully on 8 GB GPUs.',
    vramGB: 7.5,
    vramMinGB: 4,
    cpuOk: false,
    quality: 82,
    refSeconds: 8,
    unit: 'image',
    license: 'Apache-2.0',
    speed: '≈5–10 s per image',
    supportsImageInput: false,
    files: [F.zTurboInt8, F.qwen4bFp8, F.fluxAe]
  },
  {
    id: 'image-quality',
    details: {
      maker: 'Tongyi Lab (Alibaba)',
      size: '6 billion parameters, with Qwen3 4B reading the prompt',
      output: 'Pictures up to about 2 megapixels in any shape (1024×1024 by default)',
      how: 'The full model Turbo was distilled from: 28 steps with guidance, so it listens to “things to avoid” as well.',
      goodAt: ['Richer detail and texture than Turbo', 'More variety: every seed gives a different composition', 'Artistic styles, and using a negative prompt to steer away from things'],
      weakAt: ['About five times slower than Turbo', 'Needs a strong graphics card to be pleasant (12 GB or more)'],
      tips: ['Use it for the final version once Turbo found an idea you like', 'Add “things to avoid” such as blurry, watermark, extra fingers', 'Try a few seeds: the results differ more than with Turbo'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Tongyi-MAI/Z-Image'
    },
    order: 3,
    kind: 'image',
    tier: 'quality',
    name: 'Z-Image Base',
    description: 'The full, non-distilled Z-Image: richer detail, more variety, negative prompts and CFG control. 28 steps.',
    vramGB: 14,
    vramMinGB: 6,
    cpuOk: false,
    quality: 92,
    refSeconds: 40,
    unit: 'image',
    license: 'Apache-2.0',
    speed: '≈20–40 s per image',
    supportsImageInput: false,
    files: [F.zBase, F.qwen4b, F.fluxAe]
  },
  {
    id: 'image-sd15',
    details: {
      maker: 'Runway and Stability AI (2022)',
      size: 'About 1 billion parameters',
      output: '512×512 pictures (larger requests are made at 512 and keep their shape)',
      how: 'The classic diffusion model: about 25 steps with guidance, small enough for old cards and processors.',
      goodAt: ['Running almost anywhere: 4 GB graphics cards, or the processor alone', 'Painterly and illustrated styles', 'Quick sketches of an idea'],
      weakAt: ['Low resolution and soft detail', 'Hands, faces in the distance and anything with text', 'Following long or precise prompts'],
      tips: ['Keep prompts short and list the style words: “oil painting, warm light, detailed”', 'Use “things to avoid” such as blurry, deformed, text', 'Pick Z-Image instead whenever your graphics card can run it'],
      licenseNote: 'CreativeML OpenRAIL-M: free to use, including commercially, with some uses forbidden',
      link: 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5'
    },
    order: 4,
    kind: 'image',
    tier: 'fast',
    name: 'Stable Diffusion 1.5',
    description: 'The classic small model: 512×512 pictures on 4 GB GPUs, and the only image model practical on a CPU.',
    vramGB: 3,
    vramMinGB: 2,
    cpuOk: true,
    quality: 40,
    refSeconds: 2.5,
    unit: 'image',
    license: 'CreativeML OpenRAIL-M',
    speed: '≈2 s per image on a GPU, about a minute on a CPU',
    supportsImageInput: false,
    files: [F.sd15]
  },
  {
    id: 'video-lite',
    details: {
      maker: 'Wan team, Tongyi Lab (Alibaba)',
      size: '1.3 billion parameters, with UMT5 reading the prompt',
      output: '480p clips (832×480) at 16 frames per second',
      how: 'A small text-to-video model: it imagines the whole clip at once in about 30 steps.',
      goodAt: ['Short, simple scenes with clear motion: water, clouds, an animal walking', 'Graphics cards with 6–8 GB of video memory'],
      weakAt: ['Fine detail, faces and text', 'Complicated scenes or several things happening at once', 'Clips longer than a few seconds'],
      tips: ['Describe one subject and one motion: “a cat walks along a sunny wall”', 'Name the camera move: slow pan, push in, static shot'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B'
    },
    order: 5,
    kind: 'video',
    tier: 'fast',
    name: 'Wan 2.1 T2V 1.3B',
    description: 'Small text-to-video model for 6–8 GB GPUs: short 480p clips at 16 fps.',
    vramGB: 7.5,
    vramMinGB: 5,
    cpuOk: false,
    quality: 55,
    refSeconds: 90,
    unit: '2 s clip',
    license: 'Apache-2.0',
    speed: '≈1–4 min per 2 s clip',
    supportsImageInput: false,
    files: [F.wan13b, F.umt5, F.wan21Vae]
  },
  {
    id: 'video-fast',
    details: {
      maker: 'Wan team, Tongyi Lab (Alibaba)',
      size: '5 billion parameters, with UMT5 reading the prompt',
      output: '720p clips (1280×704) at 24 frames per second',
      how: 'Text-to-video and picture-to-video in one model, with a strongly compressing decoder that keeps it fast.',
      goodAt: ['Smooth 720p motion on a 16 GB graphics card', 'Animating one of your pictures (attach it in Video mode)', 'Nature, city scenes and simple actions'],
      weakAt: ['Less detail and camera control than the 14B models', 'Faces up close and text'],
      tips: ['Say what moves and how: “waves roll in slowly, spray lifts in the wind”', 'Add camera words: aerial orbit, slow push in, handheld', 'Attach a picture to start the clip from it'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B'
    },
    order: 6,
    kind: 'video',
    tier: 'fast',
    name: 'Wan 2.2 TI2V 5B',
    description: 'Text-to-video and image-to-video at 720p/24 fps with a 5B model that fits 16 GB comfortably.',
    vramGB: 11.5,
    vramMinGB: 8,
    cpuOk: false,
    quality: 75,
    refSeconds: 180,
    unit: '3 s clip',
    license: 'Apache-2.0',
    speed: '≈2–6 min per 3 s clip',
    supportsImageInput: true,
    startImage: 'optional',
    files: [F.wan5b, F.umt5, F.wan22Vae]
  },
  {
    id: 'video-quality',
    details: {
      maker: 'Wan team, Tongyi Lab (Alibaba); 4-step LoRAs by LightX2V',
      size: 'Two 14-billion-parameter experts (one plans the layout, one adds detail)',
      output: '720p clips (1280×704) at 16 frames per second',
      how: 'A mixture of experts made fast with 4-step LoRAs: the first expert lays out the scene, the second paints the detail.',
      goodAt: ['Cinematic motion, lighting and camera work', 'Following detailed descriptions of action and mood', 'People and animals moving naturally'],
      weakAt: ['Needs a 16 GB graphics card and a lot of disk space (about 37 GB)', 'Takes several minutes per clip'],
      tips: ['Write like a film director: subject, action, camera move, light, mood', 'Words such as golden hour, backlit, slow aerial orbit and shallow depth of field all work'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B'
    },
    order: 7,
    kind: 'video',
    tier: 'quality',
    name: 'Wan 2.2 A14B (text → video)',
    description: 'Cinematic 14B mixture-of-experts video model with LightX2V 4-step LoRAs. Best motion and detail.',
    vramGB: 15.5,
    vramMinGB: 12,
    cpuOk: false,
    quality: 90,
    refSeconds: 300,
    unit: '5 s clip',
    license: 'Apache-2.0',
    speed: '≈3–8 min per 5 s clip',
    supportsImageInput: false,
    files: [F.t2vHigh, F.t2vLow, F.t2vLoraHigh, F.t2vLoraLow, F.umt5, F.wan21Vae]
  },
  {
    id: 'video-quality-i2v',
    details: {
      maker: 'Wan team, Tongyi Lab (Alibaba); 4-step LoRAs by LightX2V',
      size: 'Two 14-billion-parameter experts trained to animate a picture',
      output: '720p clips at 16 frames per second, in the shape of your picture',
      how: 'Starts from your picture and keeps its look while the two experts add motion: layout first, then detail.',
      goodAt: ['Bringing a picture to life without changing its style or people', 'Natural motion of faces, animals, water and light'],
      weakAt: ['Needs a picture to start from', 'Needs a 16 GB graphics card and about 37 GB of disk space', 'Takes several minutes per clip'],
      tips: ['Attach the picture in Video mode, then describe only what moves', 'Keep the motion believable for the picture: a slow turn, a blink, wind in the hair'],
      licenseNote: 'Apache 2.0: free to use, including commercially',
      link: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B'
    },
    order: 8,
    kind: 'video',
    tier: 'quality',
    name: 'Wan 2.2 A14B (image → video)',
    description: 'Animate a picture with the 14B image-to-video experts and 4-step LoRAs.',
    vramGB: 15.5,
    vramMinGB: 12,
    cpuOk: false,
    quality: 90,
    refSeconds: 300,
    unit: '5 s clip',
    license: 'Apache-2.0',
    speed: '≈3–8 min per 5 s clip',
    supportsImageInput: true,
    startImage: 'needed',
    files: [F.i2vHigh, F.i2vLow, F.i2vLoraHigh, F.i2vLoraLow, F.umt5, F.wan21Vae]
  }
]

export const packById = (id: string): PackDef | undefined => PACKS.find((p) => p.id === id)

/** Natural size of a pack's pictures when the request does not say. */
export const nativeSize = (packId: string): number => (packId === 'image-sd15' ? 512 : 1024)

/** Small models fall apart (and crawl) above their training resolution; keep the shape, shrink the area. */
const NATIVE_AREA: Record<string, number> = { 'image-sd15': 512 * 512, 'video-lite': 832 * 480 }
export function fitSize(packId: string, width: number, height: number): [number, number] {
  const area = NATIVE_AREA[packId]
  if (!area || width * height <= area * 1.15) return [width, height]
  const s = Math.sqrt(area / (width * height))
  return [Math.max(64, Math.round((width * s) / 16) * 16), Math.max(64, Math.round((height * s) / 16) * 16)]
}

export const packSizeGB = (p: { files: MediaPackFile[] }): number =>
  Math.round((p.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0) / 1e9) * 10) / 10

const WAN_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

type Node = { class_type: string; inputs: Record<string, unknown> }
export type ApiWorkflow = Record<string, Node>

const snap = (v: number, step: number): number => Math.max(step, Math.round(v / step) * step)
/** Wan needs 4k+1 frames. */
const wanFrames = (seconds: number, fps: number): number => Math.floor((Math.max(1, seconds) * fps) / 4) * 4 + 1

export interface BuiltWorkflow {
  workflow: ApiWorkflow
  width: number
  height: number
  frames?: number
  fps?: number
  seed: number
}

/** Build a ComfyUI API-format workflow for a pack. `uploadedImage` is the ComfyUI input name. */
export function buildWorkflow(packId: string, p: MediaParams, uploadedImage?: string): BuiltWorkflow {
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48)
  const prefix = `maris/${packId}`
  if (packId === 'image-sd15') {
    const width = snap(p.width ?? 512, 8)
    const height = snap(p.height ?? 512, 8)
    const wf: ApiWorkflow = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: F.sd15.name } },
      '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: p.prompt } },
      '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: p.negative ?? 'blurry, low quality, deformed, bad anatomy, watermark, text' } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: Math.max(1, Math.min(4, p.count ?? 1)) } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
          seed,
          steps: p.steps ?? 25,
          cfg: 7,
          sampler_name: 'dpmpp_2m',
          scheduler: 'karras',
          denoise: 1
        }
      },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } }
    }
    return { workflow: wf, width, height, seed }
  }

  if (packId === 'image-fast' || packId === 'image-quality' || packId === 'image-lite') {
    const quality = packId === 'image-quality'
    const lite = packId === 'image-lite'
    const width = snap(p.width ?? 1024, 16)
    const height = snap(p.height ?? 1024, 16)
    const wf: ApiWorkflow = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: quality ? F.zBase.name : lite ? F.zTurboInt8.name : F.zTurbo.name, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: lite ? F.qwen4bFp8.name : F.qwen4b.name, type: 'lumina2', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: F.fluxAe.name } },
      '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt } },
      '6': quality
        ? { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.negative ?? 'blurry, low quality, deformed, watermark, text artifacts' } }
        : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
      '7': { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: Math.max(1, Math.min(4, p.count ?? 1)) } },
      '8': {
        class_type: 'KSampler',
        inputs: {
          model: ['4', 0],
          positive: ['5', 0],
          negative: ['6', 0],
          latent_image: ['7', 0],
          seed,
          steps: p.steps ?? (quality ? 28 : 8),
          cfg: quality ? 4 : 1,
          sampler_name: 'res_multistep',
          scheduler: 'simple',
          denoise: 1
        }
      },
      '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefix } }
    }
    return { workflow: wf, width, height, seed }
  }

  if (packId === 'video-lite') {
    const width = snap(p.width ?? 832, 16)
    const height = snap(p.height ?? 480, 16)
    const fps = 16
    const frames = p.frames ?? wanFrames(p.seconds ?? 2, fps)
    const wf: ApiWorkflow = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: F.wan13b.name, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: F.umt5.name, type: 'wan', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: F.wan21Vae.name } },
      '4': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.negative ?? WAN_NEGATIVE } },
      '7': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
      '8': {
        class_type: 'KSampler',
        inputs: {
          model: ['4', 0],
          positive: ['5', 0],
          negative: ['6', 0],
          latent_image: ['7', 0],
          seed,
          steps: p.steps ?? 30,
          cfg: 6,
          sampler_name: 'uni_pc',
          scheduler: 'simple',
          denoise: 1
        }
      },
      '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps } },
      '11': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } }
    }
    return { workflow: wf, width, height, frames, fps, seed }
  }

  if (packId === 'video-fast') {
    const width = snap(p.width ?? 1280, 32)
    const height = snap(p.height ?? 704, 32)
    const fps = 24
    const frames = p.frames ?? wanFrames(p.seconds ?? 3, fps)
    const wf: ApiWorkflow = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: F.wan5b.name, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: F.umt5.name, type: 'wan', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: F.wan22Vae.name } },
      '4': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.negative ?? WAN_NEGATIVE } },
      '7': {
        class_type: 'Wan22ImageToVideoLatent',
        inputs: { vae: ['3', 0], width, height, length: frames, batch_size: 1, ...(uploadedImage ? { start_image: ['11', 0] } : {}) }
      },
      '8': {
        class_type: 'KSampler',
        inputs: {
          model: ['4', 0],
          positive: ['5', 0],
          negative: ['6', 0],
          latent_image: ['7', 0],
          seed,
          steps: p.steps ?? 20,
          cfg: 5,
          sampler_name: 'uni_pc',
          scheduler: 'simple',
          denoise: 1
        }
      },
      '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps } },
      '12': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } }
    }
    if (uploadedImage) wf['11'] = { class_type: 'LoadImage', inputs: { image: uploadedImage } }
    return { workflow: wf, width, height, frames, fps, seed }
  }

  if (packId === 'video-quality' || packId === 'video-quality-i2v') {
    const i2v = packId === 'video-quality-i2v'
    if (i2v && !uploadedImage) throw new Error('This model animates an image: attach or pick a picture first.')
    const width = snap(p.width ?? 832, 16)
    const height = snap(p.height ?? 480, 16)
    const fps = 16
    const frames = p.frames ?? wanFrames(p.seconds ?? 5, fps)
    const [hi, lo, loraHi, loraLo] = i2v
      ? [F.i2vHigh, F.i2vLow, F.i2vLoraHigh, F.i2vLoraLow]
      : [F.t2vHigh, F.t2vLow, F.t2vLoraHigh, F.t2vLoraLow]
    const wf: ApiWorkflow = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: hi.name, weight_dtype: 'default' } },
      '2': { class_type: 'UNETLoader', inputs: { unet_name: lo.name, weight_dtype: 'default' } },
      '3': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: loraHi.name, strength_model: 1 } },
      '4': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: loraLo.name, strength_model: 1 } },
      '5': { class_type: 'ModelSamplingSD3', inputs: { model: ['3', 0], shift: 5 } },
      '6': { class_type: 'ModelSamplingSD3', inputs: { model: ['4', 0], shift: 5 } },
      '7': { class_type: 'CLIPLoader', inputs: { clip_name: F.umt5.name, type: 'wan', device: 'default' } },
      '8': { class_type: 'VAELoader', inputs: { vae_name: F.wan21Vae.name } },
      '9': { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: p.prompt } },
      '10': { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: p.negative ?? WAN_NEGATIVE } }
    }
    let pos: [string, number] = ['9', 0]
    let neg: [string, number] = ['10', 0]
    let latent: [string, number]
    if (i2v) {
      wf['17'] = { class_type: 'LoadImage', inputs: { image: uploadedImage } }
      wf['18'] = {
        class_type: 'WanImageToVideo',
        inputs: { positive: ['9', 0], negative: ['10', 0], vae: ['8', 0], start_image: ['17', 0], width, height, length: frames, batch_size: 1 }
      }
      pos = ['18', 0]
      neg = ['18', 1]
      latent = ['18', 2]
    } else {
      wf['11'] = { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } }
      latent = ['11', 0]
    }
    const common = { steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: pos, negative: neg }
    wf['12'] = {
      class_type: 'KSamplerAdvanced',
      inputs: { ...common, model: ['5', 0], add_noise: 'enable', noise_seed: seed, latent_image: latent, start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable' }
    }
    wf['13'] = {
      class_type: 'KSamplerAdvanced',
      inputs: { ...common, model: ['6', 0], add_noise: 'disable', noise_seed: 0, latent_image: ['12', 0], start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable' }
    }
    wf['14'] = { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['8', 0] } }
    wf['15'] = { class_type: 'CreateVideo', inputs: { images: ['14', 0], fps } }
    wf['16'] = { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } }
    return { workflow: wf, width, height, frames, fps, seed }
  }
  throw new Error(`Unknown media pack ${packId}`)
}

const QUALITY_RX =
  /\b(high[- ]quality|best|detailed|ultra|masterpiece|4k|8k|poster|final|professional|print|cinematic|intricate|photoreal(istic)?|hero shot)\b|качествен|детальн/i
const QUICK_RX = /\b(quick|draft|sketch|rough|test|preview|simple|fast|idea|concept)\b|быстро|набросок/i

/**
 * Choose a pack for a request ("auto" quality picks by prompt wording and what is installed).
 * `roles` are the packs the person assigned in setup or settings; they win when they can do the job.
 */
export function choosePack(
  params: MediaParams,
  installed: Set<string>,
  busy: 'idle' | 'light' | 'busy' | 'heavy',
  roles: Partial<Record<MediaRole, string>> = {}
): { packId: string; reason: string } {
  const kind = params.kind
  if (params.packId) {
    if (!installed.has(params.packId)) throw new Error(`${packById(params.packId)?.name ?? params.packId} is not installed yet.`)
    return { packId: params.packId, reason: 'chosen manually' }
  }
  const options = PACKS.filter((p) => p.kind === kind && installed.has(p.id))
  if (!options.length) {
    throw new Error(`No ${kind} model is installed yet. Open Models → ${kind === 'image' ? 'Pictures' : 'Videos'} (or run setup again from Settings) to install one.`)
  }
  const hasImage = Boolean(params.inputImage)
  let want: 'fast' | 'quality' =
    params.quality === 'quality' ? 'quality' : params.quality === 'fast' ? 'fast' : QUALITY_RX.test(params.prompt) && !QUICK_RX.test(params.prompt) ? 'quality' : 'fast'
  const reasons: string[] = []
  if (busy === 'heavy' && want === 'quality' && params.quality !== 'quality') {
    want = 'fast'
    reasons.push('GPU is busy, using the fast model')
  }
  const fits = (p: PackDef): boolean => (hasImage ? p.supportsImageInput || p.kind === 'image' : p.id !== 'video-quality-i2v')
  const roleKey: MediaRole = kind === 'image' ? (want === 'fast' ? 'imageFast' : 'imageQuality') : want === 'fast' ? 'videoFast' : 'videoQuality'
  const assigned = roles[roleKey] ? packById(roles[roleKey]!) : undefined
  if (assigned && installed.has(assigned.id) && assigned.kind === kind && fits(assigned)) {
    return { packId: assigned.id, reason: `${assigned.name}${reasons.length ? ` (${reasons.join('; ')})` : ''}` }
  }
  const ranked = options
    .filter(fits)
    .sort((a, b) => Number(b.tier === want) - Number(a.tier === want) || (want === 'quality' ? b.quality - a.quality : a.order - b.order))
  const pick = ranked[0]
  if (!pick) throw new Error('No installed model can do that. Install Wan 2.2 TI2V 5B or Wan 2.2 A14B (image → video) to animate images.')
  if (pick.tier !== want) reasons.push(`the ${want} model is not installed`)
  return { packId: pick.id, reason: `${pick.name}${reasons.length ? ` (${reasons.join('; ')})` : ''}` }
}
