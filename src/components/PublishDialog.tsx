import { useEffect, useRef, useState } from 'react'
import { db } from '../db/db'
import type { Book, Conversation, Message } from '../db/types'
import {
  isStale,
  publishSiteKey,
  publishThread,
  republishThread,
  snapshotFor,
  unpublishThread,
} from '../lib/publish'
import { linkShare, shareContent } from '../lib/share'
import { loadTurnstile } from '../lib/turnstile'
import { useModal } from '../lib/useModal'
import { button } from './ui'

/**
 * Publishes a thread at an unlisted link, or manages the link it already has.
 * Nothing is sent until the reader confirms here, and the Turnstile check runs
 * only in this dialog. See `docs/decisions/0006-public-thread-links.md`.
 */
export default function PublishDialog({
  conversation,
  messages,
  book,
  onClose,
}: {
  conversation: Conversation
  messages: Message[]
  book: Book
  onClose: () => void
}) {
  const published = conversation.published
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  // Passing the check only unlocks the button: publishing waits for the tap.
  const [token, setToken] = useState<string>()
  // Tokens are single use, so a failed attempt remounts the check for a fresh one.
  const [challenge, setChallenge] = useState(0)
  // A new link this device failed to save or remove; kept so removal can be retried.
  const [unsaved, setUnsaved] = useState<{ id: string; ownerToken: string }>()
  // A live link this device could not save holds the only owner token, so the
  // dialog stays open until it is removed, and while a request that could
  // produce one is still in flight.
  function dismiss() {
    if (working) return
    if (unsaved)
      setError(
        'Remove the link before closing. Otherwise it stays public with no way to remove it.',
      )
    else onClose()
  }
  const ref = useModal<HTMLDivElement>(dismiss, '[data-cancel]')

  async function run(action: () => Promise<void>) {
    setWorking(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setWorking(false)
    }
  }

  const snapshot = () => snapshotFor(conversation, messages, book)

  const publish = () =>
    run(async () => {
      if (!token) return
      try {
        await publishWith(token)
      } catch (err) {
        setToken(undefined)
        setChallenge((count) => count + 1)
        throw err
      }
    })

  async function publishWith(turnstileToken: string) {
    const link = await publishThread(snapshot(), turnstileToken)
    const saved = await db.conversations
      .update(conversation.id, { published: { ...link, publishedAt: Date.now() } })
      .catch(() => 0)
    // Without its owner token on this device the link could never be removed.
    if (!saved) {
      const removed = await unpublishThread(link.id, link.ownerToken).then(
        () => true,
        () => false,
      )
      if (removed) throw new Error('Could not save the link on this device, so it was removed.')
      setUnsaved(link)
      throw new Error(
        'Could not save the link on this device, and it is still live. Remove it before closing.',
      )
    }
  }

  const removeUnsaved = () =>
    run(async () => {
      if (!unsaved) return
      await unpublishThread(unsaved.id, unsaved.ownerToken)
      setUnsaved(undefined)
      setNote('The link was removed.')
    })

  const republish = () =>
    run(async () => {
      if (!published) return
      const link = await republishThread(published.id, published.ownerToken, snapshot())
      await db.conversations.update(conversation.id, {
        published: { ...published, ...link, publishedAt: Date.now() },
      })
      setNote('The link now shows the whole thread.')
    })

  const unpublish = () =>
    run(async () => {
      if (!published) return
      await unpublishThread(published.id, published.ownerToken)
      await db.conversations.update(conversation.id, { published: undefined })
      onClose()
    })

  async function share() {
    if (!published) return
    const outcome = await shareContent(linkShare(conversation, book, published.url))
    if (outcome === 'copied') setNote('Link copied to the clipboard.')
    else if (outcome === 'failed') setNote('Could not share. Copy the link above instead.')
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        className="w-full max-w-sm rounded-lg border border-rule bg-paper-leaf p-6 text-ink shadow-sheet"
      >
        <h2 id="publish-title" className="font-book text-heading font-medium">
          {published ? 'Published link' : 'Publish a link?'}
        </h2>

        {published ? (
          <>
            <input
              readOnly
              value={published.url}
              aria-label="Link to this thread"
              onFocus={(e) => e.currentTarget.select()}
              className="mt-4 min-h-tap w-full rounded-md border border-rule-strong bg-paper px-3 font-ui text-meta text-ink"
            />
            <p className="mt-2 font-ui text-meta text-ink-soft">
              Anyone with the link can read it until{' '}
              {new Date(published.expiresAt).toLocaleDateString()}.
              {isStale(conversation, messages) && ' The thread has grown since you published it.'}
            </p>
          </>
        ) : (
          <>
            <p className="mt-1.5 font-ui text-body text-ink-soft">
              Anyone with the link can read the passage, your messages and Rami’s replies. The link
              lasts a year, and you can remove it from here at any time.
            </p>
            <Challenge key={challenge} onToken={setToken} onError={setError} />
          </>
        )}

        <p aria-live="polite" className="mt-3 font-ui text-meta text-ink-soft empty:hidden">
          {working ? 'Working…' : note}
        </p>
        {error && <p className="mt-3 font-ui text-meta text-danger">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {published && (
            <button onClick={() => void unpublish()} disabled={working} className={button.danger}>
              Remove link
            </button>
          )}
          {published && isStale(conversation, messages) && (
            <button
              onClick={() => void republish()}
              disabled={working}
              className={button.secondary}
            >
              Update link
            </button>
          )}
          <button data-cancel onClick={dismiss} className={button.secondary}>
            {published ? 'Done' : 'Cancel'}
          </button>
          {published ? (
            <button onClick={() => void share()} disabled={working} className={button.primary}>
              Share link
            </button>
          ) : unsaved ? (
            <button
              onClick={() => void removeUnsaved()}
              disabled={working}
              className={button.danger}
            >
              Remove link
            </button>
          ) : (
            <button
              onClick={() => void publish()}
              disabled={working || !token}
              className={button.primary}
            >
              Publish link
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The Turnstile check. Most readers pass it without seeing a challenge; an
 * expired pass clears the token until the widget renews it.
 */
export function Challenge({
  onToken,
  onError,
}: {
  onToken: (token: string | undefined) => void
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const tokenRef = useRef(onToken)
  const errorRef = useRef(onError)
  useEffect(() => {
    tokenRef.current = onToken
    errorRef.current = onError
  })

  useEffect(() => {
    let widget: string | undefined
    let cancelled = false
    const turnstile = loadTurnstile()

    void Promise.all([publishSiteKey(), turnstile])
      .then(([sitekey, api]) => {
        if (cancelled || !ref.current) return
        widget = api.render(ref.current, {
          sitekey,
          size: 'flexible',
          theme: 'auto',
          callback: (token) => tokenRef.current(token),
          'expired-callback': () => tokenRef.current(undefined),
          'error-callback': () => errorRef.current('The verification check failed. Try again.'),
        })
      })
      .catch((err: unknown) =>
        errorRef.current(err instanceof Error ? err.message : 'Publishing is unavailable.'),
      )

    return () => {
      cancelled = true
      const rendered = widget
      if (rendered) void turnstile.then((api) => api.remove(rendered))
    }
  }, [])

  return <div ref={ref} className="mt-4 min-h-[65px]" />
}
