import { useEffect, useState, type ImgHTMLAttributes, type VideoHTMLAttributes } from 'react'
import { api, mediaUrl } from '../lib/api'
import { cn } from './ui'

type RemoteApi = { mediaBlob?: (path: string) => Promise<string> }

/**
 * Where to load a generated picture or video from: Maris's media protocol on the computer, or a
 * copy fetched and decrypted over Maris Link in the phone app.
 */
export function useMediaSrc(path?: string): string | undefined {
  const remote = (api as unknown as RemoteApi).mediaBlob
  const [src, setSrc] = useState(() => (path && !remote ? mediaUrl(path) : undefined))
  useEffect(() => {
    if (!path) {
      setSrc(undefined)
      return
    }
    if (!remote) {
      setSrc(mediaUrl(path))
      return
    }
    let live = true
    remote(path)
      .then((u) => live && setSrc(u))
      .catch(() => live && setSrc(undefined))
    return () => {
      live = false
    }
  }, [path, remote])
  return src
}

export function MediaImg({ path, className, ...rest }: { path: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const src = useMediaSrc(path)
  return src ? <img src={src} className={className} {...rest} /> : <span aria-hidden className={cn('block animate-pulse bg-sunken', className)} />
}

export function MediaVideo({ path, className, ...rest }: { path: string } & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'>) {
  const src = useMediaSrc(path)
  return src ? <video src={src} className={className} {...rest} /> : <span aria-hidden className={cn('block aspect-video animate-pulse bg-sunken', className)} />
}
