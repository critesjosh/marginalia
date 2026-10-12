# Route chat through a hosted relay that holds the key

Date: 2026-07-29
Status: Accepted

## Context

The original plan had each reader paste an OpenAI key into Settings. That made
the app unusable for a visitor arriving without one.

## Decision

Chat defaults to `/api/chat`, served by `shared/relay.ts`, which holds an
OpenRouter key server-side. The same handler runs as Vite middleware in
development and in the Cloudflare app Worker in production, so `npm run dev`
exercises the real relay. The KOReader plugin uses the same relay.

The endpoint is open to every visitor, so the relay pins model routing rather
than taking it from the request.

## History

- 2026-08-24: dropped the free model tier. Its shared upstream pool was often
  exhausted, so most requests paid a refused round trip before reaching the
  paid route anyway. Every request is now billed, and the OpenRouter credit
  limit is the only spending ceiling (see `docs/operations.md`).
- 2026-10-07: dropped the Netlify deployment; the relay runs only on
  Cloudflare Workers.
- 2026-10-11: removed the bring-your-own OpenAI key option (#133). Dexie
  version 6 deletes any stored key; the CSP no longer allows `api.openai.com`.

## Alternatives and tradeoffs

- Reader-supplied key only: no hosting cost, but no chat for most visitors.
- Free tier first, paid as fallback: cheaper in theory, but slower on success
  and a wasted round trip on failure.
- Cost: the operator pays for all hosted chat and must keep the key and
  routing server-side.
