# KOReader keeps its own digest and folds it lazily

Date: 2026-08-24
Status: Accepted

## Context

The KOReader plugin needed the same per-book memory as the PWA
([0004](0004-rolling-book-memory.md)). KOReader has one thread and a UI loop.
Folding a conversation right after a reply would either make the reader wait
twice or be cancelled by their next tap.

## Decision

The device keeps its own digest, separate from the browser's. Device notes are
not exported or reconciled with the PWA. A conversation is folded lazily, at
the start of the next question in it, while the reader is already waiting for a
model. A conversation never returned to is folded only by **Update notes now**.
One previous digest version is kept so a bad summary can be reverted from the
notes screen.

## Alternatives and tradeoffs

- Fold right after each reply, as the browser does: blocks or gets cancelled
  on the device.
- One shared digest across device and browser: needs sync and conflict
  handling. Two separate notebooks were what was asked for.
- Cost: a conversation that is never resumed stays unfolded until the reader
  asks for it.
