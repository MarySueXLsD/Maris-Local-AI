// Sample prompts for the picture and video models. scripts/make-previews.mjs renders them with each
// installed model into src/renderer/public/previews/<pack>/<sample>.(jpg|mp4) and records the timings
// in src/renderer/src/lib/previews.json; model cards show them with "Use this prompt".

export interface MediaSample {
  id: string
  prompt: string
}

/** The same prompts for every picture model, so their previews can be compared side by side. */
export const IMAGE_SAMPLES: MediaSample[] = [
  {
    id: 'tree',
    prompt:
      'A towering tree made of polished chrome and brass in a futuristic city plaza at dusk, people strolling around it, warm lights glowing in its branches, highly detailed'
  },
  {
    id: 'fisherman',
    prompt: 'Portrait of an elderly fisherman with a weathered face and a knitted cap, soft window light, shallow depth of field, 85mm photograph'
  },
  {
    id: 'nook',
    prompt: 'A cozy reading nook inside a treehouse, rain on the windows, warm lamps and stacks of books, watercolor illustration'
  },
  {
    id: 'fox',
    prompt: 'A red fox curled up in fresh snow at sunrise, frost on its fur, wildlife photography'
  }
]

/**
 * Z-Image Turbo Lite is Turbo stored in 8 bits: with the same prompts its pictures look like Turbo's, so its
 * card shows other subjects instead (everything on it is still made by Lite).
 */
export const LITE_SAMPLES: MediaSample[] = [
  {
    id: 'ramen',
    prompt: 'A steaming bowl of ramen with a soft-boiled egg, scallions and chashu on a dark wooden table, overhead food photography'
  },
  {
    id: 'rainy-car',
    prompt: 'A vintage teal car parked on a rainy city street at night, neon reflections on the wet asphalt, cinematic photograph'
  },
  {
    id: 'window-cat',
    prompt: 'A ginger cat asleep on a sunny windowsill between potted plants, soft morning light, cozy photograph'
  },
  {
    id: 'alpine-lake',
    prompt: 'A calm alpine lake at dawn with mist over the water and snowy peaks reflected in it, landscape photography'
  }
]

export const VIDEO_SAMPLES: MediaSample[] = [
  {
    id: 'boat',
    prompt: 'A paper boat drifting down a rain-soaked street gutter at night, shop lights reflecting in the water, slow camera follow, cinematic'
  },
  {
    id: 'lighthouse',
    prompt: 'Ocean waves crashing against a lighthouse at sunset, slow aerial orbit around the tower, golden light, spray in the air'
  }
]

/**
 * Image-to-video models need a picture to start from: the script makes it from one of the picture
 * prompts above (with Z-Image Turbo), then brings it to life with the motion described here.
 */
export const ANIMATE_SAMPLES: (MediaSample & { image: string })[] = [
  {
    id: 'fox-wakes',
    image: 'fox',
    prompt: 'The fox slowly lifts its head, blinks and looks around while snowflakes drift past and a light breeze moves its fur, soft morning light'
  },
  {
    id: 'tree-glow',
    image: 'tree',
    prompt: 'The lights in the chrome tree glow brighter and flicker as people stroll past, the camera slowly pushes in towards the trunk, evening atmosphere'
  }
]

/** What a rendered preview looks like in previews.json. */
export interface PreviewEntry {
  sample: string
  file: string
  poster?: string
  /** For image-to-video: the picture the clip starts from. */
  start?: string
  /** Seconds it took on the computer that made the previews. */
  seconds: number
  width: number
  height: number
}

export interface PreviewManifest {
  /** The graphics card the timings were measured on. */
  gpu: string
  packs: Record<string, PreviewEntry[]>
}

/** "Use this prompt": the text put into a new chat. */
export function samplePromptText(kind: 'image' | 'video', prompt: string): string {
  return kind === 'image' ? `Make a picture: ${prompt}` : `Make a short video: ${prompt}`
}
