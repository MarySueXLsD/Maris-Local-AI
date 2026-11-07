import type { GpuInfo, GpuVendor } from '@shared/types'

/**
 * Memory bandwidth (GB/s) and rough compute (RTX 5070 Ti = 1) of common GPUs. Language models are
 * limited by bandwidth, image and video models by compute. Unknown cards fall back to a VRAM guess.
 */
const TABLE: [RegExp, number, number][] = [
  // NVIDIA GeForce RTX 50
  [/rtx\s*5090/i, 1792, 2.3],
  [/rtx\s*5080/i, 960, 1.3],
  [/rtx\s*5070\s*ti/i, 896, 1],
  [/rtx\s*5070/i, 672, 0.72],
  [/rtx\s*5060\s*ti/i, 448, 0.52],
  [/rtx\s*5060/i, 448, 0.45],
  [/rtx\s*5050/i, 320, 0.33],
  // RTX 40
  [/rtx\s*4090/i, 1008, 1.9],
  [/rtx\s*4080\s*super/i, 736, 1.2],
  [/rtx\s*4080/i, 717, 1.12],
  [/rtx\s*4070\s*ti\s*super/i, 672, 0.95],
  [/rtx\s*4070\s*ti/i, 504, 0.88],
  [/rtx\s*4070\s*super/i, 504, 0.8],
  [/rtx\s*4070/i, 504, 0.66],
  [/rtx\s*4060\s*ti/i, 288, 0.5],
  [/rtx\s*4060/i, 272, 0.42],
  [/rtx\s*4050/i, 192, 0.3],
  // RTX 30
  [/rtx\s*3090\s*ti/i, 1008, 0.9],
  [/rtx\s*3090/i, 936, 0.82],
  [/rtx\s*3080\s*ti/i, 912, 0.78],
  [/rtx\s*3080/i, 760, 0.7],
  [/rtx\s*3070\s*ti/i, 608, 0.5],
  [/rtx\s*3070/i, 448, 0.46],
  [/rtx\s*3060\s*ti/i, 448, 0.4],
  [/rtx\s*3060/i, 360, 0.32],
  [/rtx\s*3050/i, 224, 0.2],
  // RTX 20, GTX 16 and 10
  [/rtx\s*2080\s*ti/i, 616, 0.42],
  [/rtx\s*2080/i, 448, 0.33],
  [/rtx\s*2070/i, 448, 0.28],
  [/rtx\s*2060/i, 336, 0.22],
  [/gtx\s*16\d0/i, 288, 0.1],
  [/gtx\s*1080\s*ti/i, 484, 0.12],
  [/gtx\s*10[5-8]0/i, 256, 0.08],
  // Workstation
  [/rtx\s*pro\s*6000/i, 1792, 2.3],
  [/rtx\s*pro\s*5000/i, 1344, 1.6],
  [/rtx\s*pro\s*4000/i, 672, 0.9],
  [/rtx\s*(a6000|6000\s*ada)/i, 960, 1.5],
  [/rtx\s*(a5000|5000\s*ada)/i, 768, 1],
  [/rtx\s*(a4000|4000\s*ada)/i, 448, 0.55],
  // AMD Radeon
  [/rx\s*9070\s*xt/i, 640, 0.75],
  [/rx\s*9070/i, 640, 0.65],
  [/rx\s*9060\s*xt/i, 320, 0.4],
  [/rx\s*7900\s*xtx/i, 960, 0.8],
  [/rx\s*7900\s*xt/i, 800, 0.7],
  [/rx\s*7900\s*gre/i, 576, 0.55],
  [/rx\s*7800\s*xt/i, 624, 0.5],
  [/rx\s*7700/i, 432, 0.4],
  [/rx\s*7600/i, 288, 0.28],
  [/rx\s*69[05]0/i, 576, 0.4],
  [/rx\s*6800/i, 512, 0.35],
  [/rx\s*67[05]0/i, 384, 0.28],
  [/rx\s*66[05]0/i, 256, 0.2],
  // Intel Arc
  [/arc.*b580/i, 456, 0.38],
  [/arc.*b570/i, 380, 0.32],
  [/arc.*a770/i, 560, 0.35],
  [/arc.*a750/i, 512, 0.3],
  [/arc.*a580/i, 512, 0.25],
  [/arc.*a3[18]0/i, 186, 0.1]
]

/**
 * Apple chips: [name, memory bandwidth GB/s, compute vs RTX 5070 Ti]. Binned Max chips with fewer GPU
 * cores also have less bandwidth; appleChip() handles that from the core count.
 */
const APPLE: [RegExp, number, number][] = [
  [/m1\s*ultra/i, 800, 0.25],
  [/m1\s*max/i, 400, 0.13],
  [/m1\s*pro/i, 200, 0.07],
  [/m1\b/i, 68, 0.04],
  [/m2\s*ultra/i, 800, 0.3],
  [/m2\s*max/i, 400, 0.15],
  [/m2\s*pro/i, 200, 0.08],
  [/m2\b/i, 100, 0.05],
  [/m3\s*ultra/i, 819, 0.42],
  [/m3\s*max/i, 400, 0.21],
  [/m3\s*pro/i, 150, 0.09],
  [/m3\b/i, 100, 0.06],
  [/m4\s*max/i, 546, 0.26],
  [/m4\s*pro/i, 273, 0.13],
  [/m4\b/i, 120, 0.07],
  [/m5\s*max/i, 614, 0.4],
  [/m5\s*pro/i, 307, 0.2],
  [/m5\b/i, 153, 0.12]
]

/** Bandwidth and compute of an Apple chip; unknown (newer) chips are estimated from their tier. */
export function appleChip(name: string, gpuCores?: number): { bandwidthGBs: number; perf: number } {
  const hit = APPLE.find(([rx]) => rx.test(name))
  let [bw, perf] = hit
    ? [hit[1], hit[2]]
    : /ultra/i.test(name)
      ? [820, 0.45]
      : /max/i.test(name)
        ? [550, 0.35]
        : /pro/i.test(name)
          ? [280, 0.18]
          : [150, 0.1]
  // Binned M3 Max (30 GPU cores) and M4 Max (32 cores) have three quarters of the full bandwidth.
  if (gpuCores && ((/m3\s*max/i.test(name) && gpuCores <= 30) || (/m4\s*max/i.test(name) && gpuCores <= 32))) {
    bw = Math.round(bw * 0.75)
    perf *= 0.8
  }
  return { bandwidthGBs: bw, perf }
}

/**
 * How much of an Apple chip's unified memory the GPU may use. macOS caps GPU memory at about two
 * thirds of RAM on smaller Macs and three quarters on 36 GB and more (Metal's recommendedMaxWorkingSetSize).
 */
export function appleGpuBudgetMB(totalMB: number): number {
  return Math.round(totalMB * (totalMB >= 36 * 1024 ? 0.75 : 0.66))
}

export function vendorOf(name: string): GpuVendor {
  if (/^apple\b|apple m\d/i.test(name)) return 'apple'
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name)) return 'nvidia'
  if (/amd|radeon|\bati\b|firepro/i.test(name)) return 'amd'
  if (/intel|arc\b|iris|uhd/i.test(name)) return 'intel'
  return 'other'
}

/** Virtual and remote adapters that are not real GPUs. */
export const IGNORE_GPU = /basic display|basic render|remote display|virtual|parsec|\bidd\b|citrix|vmware|hyper-v|mirage|dameware|spacedesk|displaylink|meta quest|oculus|splashtop|teamviewer|anydesk|rdp/i

export function describeGpu(raw: { name: string; vramMB: number; driver?: string; computeCap?: string; cores?: number }): GpuInfo {
  const vendor = vendorOf(raw.name)
  if (vendor === 'apple') {
    // Apple Silicon: Metal for language models (Ollama), PyTorch MPS for images and video.
    const chip = appleChip(raw.name, raw.cores)
    return {
      name: raw.name.replace(/\s+/g, ' ').trim(),
      vendor,
      vramMB: Math.round(raw.vramMB),
      integrated: false,
      unified: true,
      cores: raw.cores,
      driver: raw.driver,
      bandwidthGBs: chip.bandwidthGBs,
      perf: chip.perf,
      llm: 'metal',
      comfy: 'mps'
    }
  }
  const laptop = /laptop|mobile|max-q/i.test(raw.name)
  const integrated =
    raw.vramMB < 1536 ||
    (vendor === 'intel' && !/arc/i.test(raw.name)) ||
    (vendor === 'amd' && /radeon\(tm\) graphics|radeon graphics|vega \d|\d{3}m\b/i.test(raw.name) && raw.vramMB < 4096)
  const hit = TABLE.find(([rx]) => rx.test(raw.name))
  const vramGB = raw.vramMB / 1024
  let bw = hit ? hit[1] : Math.max(60, vramGB * 28)
  let perf = hit ? hit[2] : Math.max(0.03, vramGB / 26)
  if (laptop && hit) {
    bw *= 0.55
    perf *= 0.7
  }
  if (integrated) {
    bw = 60
    perf = 0.05
  }
  const cc = Number(raw.computeCap ?? '0')
  const driverMajor = Number((raw.driver ?? '').split('.')[0]) || 0
  let llm: GpuInfo['llm'] = 'none'
  let comfy: GpuInfo['comfy'] = 'none'
  if (!integrated) {
    if (vendor === 'nvidia') {
      llm = !cc || cc >= 5 ? 'cuda' : 'none'
      // The main ComfyUI build uses CUDA 13 (Turing or newer, driver 580+); older setups get the CUDA 12.6 build.
      const modern = (!cc || cc >= 7.5) && (!driverMajor || driverMajor >= 580)
      comfy = !cc || cc >= 5 ? (modern ? 'nvidia' : 'nvidia_cu126') : 'none'
    } else if (vendor === 'amd') {
      const rdna3plus = /rx\s*(7\d{3}|9\d{3})/i.test(raw.name)
      llm = rdna3plus || /rx\s*6[89]\d0/i.test(raw.name) ? 'rocm' : 'vulkan'
      comfy = rdna3plus ? 'amd' : 'none'
    } else if (vendor === 'intel') {
      llm = 'vulkan'
      comfy = /arc/i.test(raw.name) ? 'intel' : 'none'
    }
  }
  if (process.platform === 'darwin') {
    // Intel Macs: Ollama and PyTorch only use the GPU of Apple chips.
    llm = 'none'
    comfy = 'none'
  } else if (process.platform === 'linux' && vendor === 'amd' && !integrated && /rx\s*6[89]\d0/i.test(raw.name)) {
    // ROCm PyTorch on Linux also supports RDNA 2 (RX 6800/6900), unlike the Windows portable build.
    comfy = 'amd'
  }
  return {
    name: raw.name.replace(/\s+/g, ' ').trim(),
    vendor,
    vramMB: Math.round(raw.vramMB),
    integrated,
    driver: raw.driver,
    computeCap: raw.computeCap,
    bandwidthGBs: Math.round(bw),
    perf: Math.round(perf * 100) / 100,
    llm,
    comfy
  }
}
