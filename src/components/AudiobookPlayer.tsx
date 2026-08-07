import { useEffect, useRef, useState } from 'react'
import { saveSettings } from '../db/db'
import type { ReaderTheme } from '../db/types'
import { createAudiobookSession, loadAudiobookMetadata } from '../lib/audiobooks'
import { THEMES } from '../lib/themes'
import { CloseIcon } from './Icons'

interface Props {
  token?: string
  theme: ReaderTheme
  hidden: boolean
  initialPosition: number
  onHide: () => void
}

export default function AudiobookPlayer({ token, theme, hidden, initialPosition, onHide }: Props) {
  const [audioUrl, setAudioUrl] = useState<string>()
  const [title, setTitle] = useState('Twilight of the Idols')
  const [error, setError] = useState<string>()
  const [sessionAttempt, setSessionAttempt] = useState(0)
  const resumePosition = useRef(initialPosition)
  const lastSavedPosition = useRef(initialPosition)
  const retriedPlayback = useRef(false)
  const palette = THEMES[theme]

  useEffect(() => {
    if (!token) return
    let cancelled = false

    void (async () => {
      try {
        const session = await createAudiobookSession(token)
        if (cancelled) return
        setAudioUrl(session.audioUrl)
        setError(undefined)

        try {
          const metadata = await loadAudiobookMetadata(session.metadataUrl)
          if (!cancelled && metadata.title) setTitle(metadata.title)
        } catch {
          // The signed audio URL is useful even if optional display metadata fails.
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the audiobook.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [token, sessionAttempt])

  function restorePosition(audio: HTMLAudioElement) {
    const position = resumePosition.current
    if (Number.isFinite(position) && position > 0 && position < audio.duration) {
      audio.currentTime = position
    }
  }

  function persistPosition(audio: HTMLAudioElement, force = false) {
    const position = audio.currentTime
    resumePosition.current = position
    if (!force && Math.abs(position - lastSavedPosition.current) < 15) return
    lastSavedPosition.current = position
    void saveSettings({ audiobookPositionSeconds: position })
  }

  function handlePlaybackError(audio: HTMLAudioElement) {
    persistPosition(audio, true)
    if (!retriedPlayback.current) {
      retriedPlayback.current = true
      setAudioUrl(undefined)
      setSessionAttempt((attempt) => attempt + 1)
      return
    }
    setError('Audio playback failed. Check your connection and reopen the player.')
  }

  return (
    <section
      aria-label="Audiobook player"
      className={`no-select absolute inset-x-3 bottom-16 z-40 rounded-xl border p-3 shadow-2xl ${palette.chrome} ${palette.border} ${hidden ? 'hidden' : ''}`}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs opacity-60">Personal audiobook · starts at the Introduction</p>
        </div>
        <button onClick={onHide} aria-label="Hide audiobook controls" className="rounded-lg p-1 opacity-70">
          <CloseIcon />
        </button>
      </div>

      {!token ? (
        <p className="text-sm opacity-75">
          Add your personal audiobook token in Settings, then reopen the player.
        </p>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : audioUrl ? (
        <audio
          className="h-10 w-full"
          controls
          preload="metadata"
          src={audioUrl}
          onLoadedMetadata={(event) => restorePosition(event.currentTarget)}
          onTimeUpdate={(event) => persistPosition(event.currentTarget)}
          onPause={(event) => persistPosition(event.currentTarget, true)}
          onPlaying={() => {
            retriedPlayback.current = false
          }}
          onEnded={() => void saveSettings({ audiobookPositionSeconds: 0 })}
          onError={(event) => handlePlaybackError(event.currentTarget)}
        >
          Your browser does not support Opus audio.
        </audio>
      ) : (
        <p className="text-sm opacity-65">Unlocking audiobook…</p>
      )}
    </section>
  )
}
