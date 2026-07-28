import type { ReaderTheme } from '../db/types'

export interface ThemePalette {
  /** Page background, applied to both the app chrome and the epub.js iframe. */
  bg: string
  fg: string
  muted: string
  link: string
  /** Tailwind classes for the surrounding reader chrome. */
  chrome: string
  chromeText: string
  border: string
}

export const THEMES: Record<ReaderTheme, ThemePalette> = {
  light: {
    bg: '#faf9f7',
    fg: '#1c1917',
    muted: '#78716c',
    link: '#b45309',
    chrome: 'bg-[#faf9f7]',
    chromeText: 'text-stone-800',
    border: 'border-stone-300',
  },
  sepia: {
    bg: '#f4ecd8',
    fg: '#3b2f1e',
    muted: '#8a7a5c',
    link: '#9a5b0e',
    chrome: 'bg-[#f4ecd8]',
    chromeText: 'text-[#3b2f1e]',
    border: 'border-[#ddd0b0]',
  },
  dark: {
    bg: '#1c1917',
    fg: '#e7e5e4',
    muted: '#a8a29e',
    link: '#fbbf24',
    chrome: 'bg-stone-900',
    chromeText: 'text-stone-200',
    border: 'border-stone-700',
  },
}

/** Styles injected into the epub.js iframe for a given theme. */
export function epubThemeStyles(theme: ReaderTheme) {
  const p = THEMES[theme]
  return {
    body: {
      background: `${p.bg} !important`,
      color: `${p.fg} !important`,
      'font-family': "'Iowan Old Style', Palatino, Georgia, serif !important",
      'line-height': '1.6 !important',
      padding: '0 !important',
    },
    'p, li, div, span, td': { color: `${p.fg} !important` },
    'h1, h2, h3, h4, h5, h6': { color: `${p.fg} !important` },
    a: { color: `${p.link} !important` },
    'img, svg': { 'max-width': '100% !important', height: 'auto !important' },
    '::selection': { background: 'rgba(245, 158, 11, 0.35)' },
  }
}
