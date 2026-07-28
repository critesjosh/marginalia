import type { NavItem } from 'epubjs'
import type { ReaderTheme } from '../db/types'
import { THEMES } from '../lib/themes'
import { CloseIcon } from './Icons'

export default function TocDrawer({
  toc,
  theme,
  currentChapterHref,
  onSelect,
  onClose,
}: {
  toc: NavItem[]
  theme: ReaderTheme
  /** Exact TOC href of the current chapter, anchor included. */
  currentChapterHref?: string
  onSelect: (href: string) => void
  onClose: () => void
}) {
  const palette = THEMES[theme]

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`relative flex h-full w-[85%] max-w-sm flex-col ${palette.chrome} ${palette.chromeText} shadow-2xl`}
      >
        <header
          className={`pt-safe flex items-center justify-between border-b px-4 pb-3 ${palette.border}`}
        >
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-60">
            Contents
          </h2>
          <button onClick={onClose} aria-label="Close contents" className="p-1 opacity-70">
            <CloseIcon />
          </button>
        </header>

        <nav className="flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {toc.length === 0 && (
            <p className="px-2 py-4 text-sm opacity-60">This book has no table of contents.</p>
          )}
          <TocList
            items={toc}
            depth={0}
            currentChapterHref={currentChapterHref}
            palette={palette}
            onSelect={onSelect}
          />
        </nav>
      </aside>
    </div>
  )
}

function TocList({
  items,
  depth,
  currentChapterHref,
  palette,
  onSelect,
}: {
  items: NavItem[]
  depth: number
  currentChapterHref?: string
  palette: (typeof THEMES)[ReaderTheme]
  onSelect: (href: string) => void
}) {
  return (
    <ul>
      {items.map((item, i) => {
        const isCurrent = Boolean(currentChapterHref && item.href === currentChapterHref)
        return (
          <li key={`${item.href}-${i}`}>
            <button
              onClick={() => item.href && onSelect(item.href)}
              style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
              className={`w-full rounded-md py-2.5 pr-3 text-left text-sm leading-snug ${
                isCurrent ? 'font-semibold' : 'opacity-80'
              }`}
            >
              <span
                style={isCurrent ? { color: palette.link } : undefined}
                className="line-clamp-2"
              >
                {item.label?.trim() || 'Untitled'}
              </span>
            </button>
            {item.subitems && item.subitems.length > 0 && (
              <TocList
                items={item.subitems}
                depth={depth + 1}
                currentChapterHref={currentChapterHref}
                palette={palette}
                onSelect={onSelect}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
