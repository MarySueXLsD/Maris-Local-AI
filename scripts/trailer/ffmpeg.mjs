// Where ffmpeg is: FFMPEG if set, ffmpeg on the PATH, or the one the imageio-ffmpeg Python package brings.
import { spawnSync } from 'node:child_process'

let found
export function ffmpeg() {
  if (found) return found
  const works = (exe) => exe && spawnSync(exe, ['-version'], { encoding: 'utf8' }).status === 0
  if (works(process.env.FFMPEG)) return (found = process.env.FFMPEG)
  if (works('ffmpeg')) return (found = 'ffmpeg')
  for (const py of ['python', 'python3', 'py']) {
    const r = spawnSync(py, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' })
    const exe = r.status === 0 ? r.stdout.trim() : ''
    if (works(exe)) return (found = exe)
  }
  throw new Error('ffmpeg was not found: put it on the PATH, set FFMPEG, or run "pip install imageio-ffmpeg"')
}
