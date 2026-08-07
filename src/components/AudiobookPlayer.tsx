import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveSettings } from '../db/db'
import type { ReaderTheme } from '../db/types'
import {
  AUDIOBOOK_POSITION_KEY,
  absoluteChapterTime,
  chapterIndexAtTime,
  chapterRelativeTime,
  clampPlaybackTime,
  createAudiobookSession,
  loadAudiobookMetadata,
  parseStoredAudiobookPosition,
  type AudiobookMetadata,
} from '../lib/audiobooks'
import { THEMES } from '../lib/themes'
import { CloseIcon } from './Icons'

interface Props {
  token?: string
  theme: ReaderTheme
  hidden: boolean
  initialPosition: number
  onHide: () => void
}

interface PendingRestore {
  positionSeconds: number
  shouldPlay: boolean
}

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

function formatSpokenTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
  const values = [
    [Math.floor(seconds / 3600), 'hour'],
    [Math.floor((seconds % 3600) / 60), 'minute'],
    [seconds % 60, 'second'],
  ] as const
  const parts = values
    .filter(([value], index) => value > 0 || (index === 2 && seconds === 0))
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`)
  return parts.join(' ')
}

export default function AudiobookPlayer({ token, theme, hidden, initialPosition, onHide }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioUrl, setAudioUrl] = useState<string>()
  const [metadata, setMetadata] = useState<AudiobookMetadata>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [sessionAttempt, setSessionAttempt] = useState(0)
  const [currentTime, setCurrentTime] = useState(initialPosition)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState(0)
  const pendingRestore = useRef<PendingRestore | undefined>(undefined)
  const pendingSeekTarget = useRef<number | undefined>(undefined)
  const restorePending = useRef(true)
  const lastSavedPosition = useRef(initialPosition)
  const retriedPlayback = useRef(false)
  const palette = THEMES[theme]

  // Read through a ref, never an effect dependency: `initialPosition` comes from
  // the live settings query, and persisting a position feeds straight back into
  // it. Depending on it here would tear down the session mid-playback.
  const initialPositionRef = useRef(initialPosition)
  initialPositionRef.current = initialPosition

  useEffect(() => {
    if (!token) return
    if (!document.createElement('audio').canPlayType('audio/ogg; codecs="opus"')) {
      setError('This browser cannot play the Opus audiobook. On iPhone or iPad, use iOS 18.4 or newer.')
      return
    }
    let cancelled = false

    void (async () => {
      try {
        const session = await createAudiobookSession(token)
        const nextMetadata = await loadAudiobookMetadata(session.metadataUrl)
        if (cancelled) return

        if (!pendingRestore.current) {
          const serializedPosition = window.localStorage.getItem(AUDIOBOOK_POSITION_KEY)
          const stored = parseStoredAudiobookPosition(
            serializedPosition,
            nextMetadata,
          )
          pendingRestore.current = {
            positionSeconds: clampPlaybackTime(
              stored?.positionSeconds ??
                (serializedPosition === null ? initialPositionRef.current : 0),
              nextMetadata.audiobook.durationSeconds,
            ),
            shouldPlay: false,
          }
        }

        restorePending.current = true
        setMetadata(nextMetadata)
        setAudioUrl(session.audioUrl)
        setError(undefined)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the audiobook.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionAttempt, token])

  const activeChapterIndex = useMemo(
    () => (metadata ? chapterIndexAtTime(metadata.chapters, currentTime) : -1),
    [currentTime, metadata],
  )
  const activeChapter = metadata?.chapters[activeChapterIndex]
  const chapterDuration = activeChapter
    ? activeChapter.endSeconds - activeChapter.startSeconds
    : 0
  const chapterTime = activeChapter ? chapterRelativeTime(activeChapter, currentTime) : 0
  const displayedChapterTime = isScrubbing ? scrubValue : chapterTime

  const persistPosition = useCallback((force = false) => {
    const audio = audioRef.current
    if (!audio || !metadata || restorePending.current || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      return
    }
    const position = clampPlaybackTime(audio.currentTime, metadata.audiobook.durationSeconds)
    if (!force && Math.abs(position - lastSavedPosition.current) < 5) return

    lastSavedPosition.current = position
    const stored = {
      audioId: metadata.audiobook.audioId,
      positionSeconds: position,
      updatedAt: Date.now(),
    }
    window.localStorage.setItem(AUDIOBOOK_POSITION_KEY, JSON.stringify(stored))
    // localStorage is the hot path; the settings mirror only needs to be current
    // at the moments a reader can actually leave, and each write re-runs the
    // live settings query that re-renders the whole reader.
    if (force) void saveSettings({ audiobookPositionSeconds: position })
  }, [metadata])

  useEffect(() => {
    function persistWhenLeaving() {
      persistPosition(true)
    }
    function persistWhenHidden() {
      if (document.visibilityState === 'hidden') persistPosition(true)
    }
    window.addEventListener('pagehide', persistWhenLeaving)
    document.addEventListener('visibilitychange', persistWhenHidden)
    return () => {
      window.removeEventListener('pagehide', persistWhenLeaving)
      document.removeEventListener('visibilitychange', persistWhenHidden)
      persistPosition(true)
    }
  }, [persistPosition])

  const seekTo = useCallback((absoluteSeconds: number) => {
    const audio = audioRef.current
    if (!audio || !metadata) return
    const position = clampPlaybackTime(absoluteSeconds, metadata.audiobook.durationSeconds)
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingRestore.current = { positionSeconds: position, shouldPlay: false }
      restorePending.current = true
      setCurrentTime(position)
      return
    }
    pendingSeekTarget.current = position
    audio.currentTime = position
    setCurrentTime(position)
  }, [metadata])

  const updateMediaSessionPosition = useCallback((position: number) => {
    if (!metadata || !('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.setPositionState({
        duration: metadata.audiobook.durationSeconds,
        playbackRate: audioRef.current?.playbackRate ?? 1,
        position: Math.min(position, metadata.audiobook.durationSeconds),
      })
    } catch {
      // Some browsers expose Media Session but not position state.
    }
  }, [metadata])

  useEffect(() => {
    if (!metadata || !activeChapter || !('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeChapter.title,
      artist: metadata.author,
      album: metadata.title,
    })
    updateMediaSessionPosition(audioRef.current?.currentTime ?? activeChapter.startSeconds)
  }, [activeChapter, metadata, updateMediaSessionPosition])

  useEffect(() => {
    if (!metadata || !('mediaSession' in navigator)) return
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Action support varies between browsers.
      }
    }
    const audio = audioRef.current
    setHandler('play', () => void audio?.play())
    setHandler('pause', () => audio?.pause())
    setHandler('seekbackward', (details) => seekTo((audio?.currentTime ?? 0) - (details.seekOffset ?? 15)))
    setHandler('seekforward', (details) => seekTo((audio?.currentTime ?? 0) + (details.seekOffset ?? 15)))
    setHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') seekTo(details.seekTime)
    })
    setHandler('previoustrack', () => seekTo(metadata.chapters[Math.max(0, activeChapterIndex - 1)].startSeconds))
    setHandler('nexttrack', () => seekTo(metadata.chapters[Math.min(metadata.chapters.length - 1, activeChapterIndex + 1)].startSeconds))

    return () => {
      for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) {
        setHandler(action, null)
      }
    }
  }, [activeChapterIndex, metadata, seekTo])

  function restorePosition(audio: HTMLAudioElement) {
    if (!metadata) return
    const restore = pendingRestore.current ?? {
      positionSeconds: initialPosition,
      shouldPlay: false,
    }
    const position = clampPlaybackTime(
      restore.positionSeconds,
      metadata.audiobook.durationSeconds,
    )
    audio.currentTime = position
    setCurrentTime(position)
    lastSavedPosition.current = position
    pendingRestore.current = undefined
    restorePending.current = false

    if (restore.shouldPlay) {
      void audio.play().catch(() => {
        setNotice('Tap play to continue after reconnecting.')
      })
    }
  }

  function handlePlaybackError(audio: HTMLAudioElement) {
    if (!metadata) {
      setError('Audio playback failed. Check your connection and reopen the player.')
      return
    }
    persistPosition(true)
    if (!retriedPlayback.current && audio.error?.code === MediaError.MEDIA_ERR_NETWORK) {
      retriedPlayback.current = true
      pendingRestore.current = {
        positionSeconds: audio.currentTime,
        shouldPlay: isPlaying,
      }
      restorePending.current = true
      setAudioUrl(undefined)
      setSessionAttempt((attempt) => attempt + 1)
      return
    }
    setError('Audio playback failed. Check your connection and reopen the player.')
  }

  function togglePlayback() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      setNotice(undefined)
      void audio.play().catch(() => setNotice('Playback needs another tap to start.'))
    } else {
      audio.pause()
    }
  }

  function selectChapter(index: number) {
    const chapter = metadata?.chapters[index]
    if (!chapter) return
    persistPosition(true)
    seekTo(chapter.startSeconds)
  }

  function commitScrub() {
    if (!activeChapter) return
    seekTo(absoluteChapterTime(activeChapter, scrubValue))
    setIsScrubbing(false)
  }

  const controlClass = `flex h-11 min-w-11 items-center justify-center rounded-lg border px-3 ${palette.border} disabled:opacity-35`

  return (
    <section
      aria-label="Audiobook player"
      className={`no-select absolute inset-x-3 bottom-16 z-40 rounded-xl border p-3 shadow-2xl ${palette.chrome} ${palette.chromeText} ${palette.border} ${hidden ? 'hidden' : ''}`}
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{metadata?.title ?? 'Twilight of the Idols'}</p>
          <p className="truncate text-xs opacity-60">
            {activeChapter?.title ?? 'Personal audiobook · starts at the Introduction'}
          </p>
        </div>
        <button
          onClick={onHide}
          aria-label="Hide audiobook controls"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg opacity-70"
        >
          <CloseIcon />
        </button>
      </div>

      {!token ? (
        <p className="text-sm opacity-75">
          Add your personal audiobook token in Settings, then reopen the player.
        </p>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : audioUrl && metadata && activeChapter ? (
        <>
          <audio
            ref={audioRef}
            preload="metadata"
            src={audioUrl}
            onLoadedMetadata={(event) => restorePosition(event.currentTarget)}
            onTimeUpdate={(event) => {
              if (!restorePending.current) {
                const position = event.currentTarget.currentTime
                const target = pendingSeekTarget.current
                if (target !== undefined && Math.abs(position - target) > 0.75) return
                pendingSeekTarget.current = undefined
                setCurrentTime(position)
                persistPosition()
                updateMediaSessionPosition(position)
              }
            }}
            onSeeked={(event) => {
              pendingSeekTarget.current = undefined
              setCurrentTime(event.currentTarget.currentTime)
              persistPosition(true)
            }}
            onPlay={() => {
              setIsPlaying(true)
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
            }}
            onPause={() => {
              setIsPlaying(false)
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
              persistPosition(true)
            }}
            onPlaying={() => {
              retriedPlayback.current = false
              setNotice(undefined)
            }}
            onEnded={() => {
              setIsPlaying(false)
              lastSavedPosition.current = 0
              window.localStorage.setItem(AUDIOBOOK_POSITION_KEY, JSON.stringify({
                audioId: metadata.audiobook.audioId,
                positionSeconds: 0,
                updatedAt: Date.now(),
              }))
              void saveSettings({ audiobookPositionSeconds: 0 })
            }}
            onError={(event) => handlePlaybackError(event.currentTarget)}
          >
            Your browser does not support Opus audio.
          </audio>

          <label className="mb-1 block text-xs opacity-65" htmlFor="audiobook-chapter">
            Chapter {activeChapterIndex + 1} of {metadata.chapters.length}
          </label>
          <select
            id="audiobook-chapter"
            className={`mb-3 h-11 w-full rounded-lg border bg-transparent px-3 text-sm ${palette.border}`}
            value={activeChapterIndex}
            onChange={(event) => selectChapter(Number(event.target.value))}
          >
            {metadata.chapters.map((chapter, index) => (
              <option key={chapter.id} value={index} className={palette.chrome}>
                {chapter.title}
              </option>
            ))}
          </select>

          <label htmlFor="audiobook-progress" className="sr-only">
            Position within {activeChapter.title}
          </label>
          <input
            id="audiobook-progress"
            className="h-7 w-full accent-amber-500"
            type="range"
            min="0"
            max={chapterDuration}
            step="0.5"
            value={displayedChapterTime}
            aria-valuetext={`${formatSpokenTime(displayedChapterTime)} of ${formatSpokenTime(chapterDuration)} in ${activeChapter.title}`}
            onPointerDown={() => {
              setScrubValue(chapterTime)
              setIsScrubbing(true)
            }}
            onChange={(event) => {
              const value = Number(event.target.value)
              setScrubValue(value)
              if (!isScrubbing) seekTo(absoluteChapterTime(activeChapter, value))
            }}
            onPointerUp={commitScrub}
            onPointerCancel={() => setIsScrubbing(false)}
            onKeyUp={commitScrub}
            onBlur={() => {
              if (isScrubbing) commitScrub()
            }}
          />
          <div className="mb-2 flex justify-between text-xs tabular-nums opacity-65">
            <span>{formatTime(displayedChapterTime)}</span>
            <span>{formatTime(chapterDuration)}</span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className={controlClass}
              aria-label="Previous chapter"
              disabled={activeChapterIndex === 0}
              onClick={() => selectChapter(activeChapterIndex - 1)}
            >
              |‹
            </button>
            <button
              type="button"
              className={controlClass}
              aria-label="Go back 15 seconds"
              onClick={() => seekTo(currentTime - 15)}
            >
              −15
            </button>
            <button
              type="button"
              className={`${controlClass} rounded-full bg-amber-500 text-lg text-stone-950`}
              aria-label={isPlaying ? 'Pause audiobook' : 'Play audiobook'}
              onClick={togglePlayback}
            >
              {isPlaying ? 'Ⅱ' : '▶'}
            </button>
            <button
              type="button"
              className={controlClass}
              aria-label="Go forward 15 seconds"
              onClick={() => seekTo(currentTime + 15)}
            >
              +15
            </button>
            <button
              type="button"
              className={controlClass}
              aria-label="Next chapter"
              disabled={activeChapterIndex === metadata.chapters.length - 1}
              onClick={() => selectChapter(activeChapterIndex + 1)}
            >
              ›|
            </button>
          </div>

          <p aria-live="polite" className="mt-2 min-h-4 text-center text-xs opacity-65">
            {notice}
          </p>
        </>
      ) : (
        <p className="text-sm opacity-65">Unlocking audiobook…</p>
      )}
    </section>
  )
}
