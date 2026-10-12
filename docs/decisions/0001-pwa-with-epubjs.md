# Build a PWA on epub.js, not a native Android app

Date: 2026-07-28
Status: Accepted

## Context

The reader targets Android phones first. It needs text selection, highlights,
stable positions within a book, offline reading, and local storage for whole
EPUB files.

## Decision

Build a React/TypeScript PWA that renders with epub.js and stores books,
highlights, conversations, and memory in IndexedDB through Dexie. epub.js
provides selection, annotations, and CFI positions in the browser. A PWA
installs from the browser, works offline through a service worker, needs no
store review, and also runs on desktop and tablet.

## Alternatives and tradeoffs

- Native Android: no Kotlin EPUB renderer matches epub.js, so a native app
  would wrap a WebView anyway.
- Capacitor or TWA wrapper: the upgrade path if deep OS integration (share
  target, background sync, widgets) is ever needed. Not needed yet.
- Cost: iOS Safari caps IndexedDB storage more aggressively, and only DRM-free
  EPUBs work.
