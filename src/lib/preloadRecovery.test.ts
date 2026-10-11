import { describe, expect, it } from 'vitest'
import { shouldReloadForPreloadError } from './preloadRecovery'

describe('preload recovery', () => {
  it('allows one reload per build even when the browser gives every failure the same message', () => {
    const entries = new Map<string, string>()
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value)
      },
    } as Storage
    const failure = new TypeError('Importing a module script failed.')

    expect(shouldReloadForPreloadError(failure, storage, 'build-a')).toBe(true)
    expect(shouldReloadForPreloadError(failure, storage, 'build-a')).toBe(false)
    expect(shouldReloadForPreloadError(failure, storage, 'build-b')).toBe(true)
  })

  it('does not reload when storage cannot keep the loop guard', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(shouldReloadForPreloadError(new Error('missing bundle'), storage, 'build-a')).toBe(false)
    expect(shouldReloadForPreloadError('missing bundle', storage, 'build-a')).toBe(false)
  })
})
