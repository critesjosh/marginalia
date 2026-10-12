# Match books by EPUB file hash, not title

Date: 2026-08-20
Status: Accepted

## Context

A reader can archive a book: the EPUB bytes are dropped but highlights,
conversations, memory, and position are kept. Re-importing the book should
restore that shelf. Restore first matched on normalized title and author.

Two editions of one work share title and author but number their sections
differently. A CFI from one edition points at the wrong place in the other, so
title matching silently attached notes and positions to the wrong text.

## Decision

Each import stores a SHA-256 of the EPUB, kept after the file is archived. Only
an exact hash match restores an archived book; anything else imports as a new
book. Books that predate the hash get one when archived, while they still have
their bytes. An archived book with no hash never matches.

## Alternatives and tradeoffs

- Title/author matching: convenient, but wrong across editions and silent.
- Re-anchoring notes by text search: more forgiving, but not built yet (M6).
- Cost: a re-downloaded copy with different bytes, even of the same edition,
  imports as a separate book.
