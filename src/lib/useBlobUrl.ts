import { useEffect, useState } from 'react'

/** Turns a Blob into an object URL and revokes it when the blob changes or unmounts. */
export function useBlobUrl(blob?: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  return url
}
