# Keep a bounded rolling digest per book as chat memory

Date: 2026-07-28
Status: Accepted

## Context

New conversations should know what the reader already discussed about the same
book, without sending every past transcript to the model.

## Decision

After a conversation turn, one extra model call folds it into a per-book
digest. The digest is fenced into the system prompt of every new conversation
for that book. Readers can view and edit it in the reader's Memory tab.

The digest is bounded (2026-08-07). Each update feeds the stored digest back to
the summarizer, so nothing shrinks it, and the summarizer echoed fence
delimiters that then accumulated. Every write path strips echoed delimiters and
clamps the digest at 4,000 characters, truncating at the latest paragraph,
line, sentence, or word boundary. The transcript sent to the summarizer is
also bounded.

## Alternatives and tradeoffs

- Full history in every prompt: grows without limit.
- Embedding past exchanges and retrieving the top matches: more precise
  recall, more moving parts. Deferred.
- Cost: an extra billed call per update, and a bad summary can feed into later
  ones until the reader edits it.
