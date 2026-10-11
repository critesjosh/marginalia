const RELOAD_PREFIX = 'rami:preload-reload:'

/** Reload once per build so an open tab can pick up a new deployment. */
export function shouldReloadForPreloadError(
  error: unknown,
  storage: Storage,
  buildId: string,
): boolean {
  if (!(error instanceof Error)) return false
  const key = `${RELOAD_PREFIX}${buildId}`

  try {
    if (storage.getItem(key)) return false
    storage.setItem(key, '1')
    return true
  } catch {
    // Without a persistent guard, reloading could trap the reader in a loop.
    return false
  }
}
