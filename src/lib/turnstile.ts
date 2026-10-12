/**
 * Loads Cloudflare Turnstile on demand. Only publishing a thread needs it, so
 * the script is fetched the first time the publish dialog opens, never on a
 * normal read. The Worker's CSP allows its origin for scripts and frames.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      'error-callback'?: () => void
      'expired-callback'?: () => void
      theme?: 'auto' | 'light' | 'dark'
      size?: 'normal' | 'flexible' | 'compact'
    },
  ): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let loading: Promise<Turnstile> | undefined

export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load.'))
    script.onerror = () => {
      loading = undefined
      script.remove()
      reject(new Error('Could not load the verification check.'))
    }
    document.head.append(script)
  })
  return loading
}
