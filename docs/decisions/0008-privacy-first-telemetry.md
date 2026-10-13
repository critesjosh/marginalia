# Send privacy-first product telemetry to PostHog Cloud

Date: 2026-10-12
Status: Accepted (production enablement pending privacy review)

## Context

Rami had no product telemetry: third-party telemetry was a listed non-goal, and
the only error signal was a storage log the reader could attach to a GitHub
issue. That leaves no way to see whether imports, opening books, selection,
highlights or chat are failing for readers who never file an issue, or which
build introduced a failure.

The reader's books, notes and conversations are private, and the app promises
they stay on the device. Any telemetry has to keep that promise by
construction, not by convention at each call site.

## Decision

- **PostHog Cloud, through a same-origin relay.** The PWA posts batches to
  `POST /api/telemetry/events` on Rami's own Worker (`shared/telemetryRelay.ts`).
  The relay rebuilds each event from the allowlist, sets PostHog's privacy
  flags itself, adds the project key and forwards to `<host>/batch/` with none
  of the reader's request headers, so PostHog never receives their IP address
  or user agent. The PWA does not load `posthog-js`, and `connect-src` stays
  `'self'`.
- **Off unless configured, on the server.** The relay collects nothing
  unless the Worker has a `TELEMETRY_KEY` secret (a public `phc_` project key;
  any other key type is refused) and a `TELEMETRY_HOST`. The browser holds no
  key and learns from `GET /api/telemetry/config` whether to collect.
  Production and Previews have no key until privacy review, and deleting the
  secret stops collection without a build.
- **Consent first, by region.** Before the reader chooses, the default comes
  from `GET /api/telemetry/config`, which maps Cloudflare's country for the
  request (read, never stored or logged) to a rule. The EU, EEA, Switzerland
  and unknown countries are opt-in: the EDPB reads ePrivacy Article 5(3) as
  covering JavaScript that sends data from the device, and analytics is not
  exempt. Elsewhere, including the UK under PECR's statistical-purposes
  exception (in force 5 February 2026), it is opt-out with notice. Events are
  held, unsent, until the region is known. A one-time notice, shown on
  whichever page the reader lands, asks (opt-in) or informs with a Turn off button (opt-out); declining is as
  easy as accepting. Global Privacy Control or Do Not Track keeps it off with
  no notice. `TELEMETRY_DEFAULT=off` on the Worker makes it opt-in everywhere. The
  Settings toggle changes it at any time and drops queued events.
- **Allowlisted events and properties.** `shared/telemetrySchema.ts` names
  every event and the enum, boolean or bounded values each property may take.
  Everything else is dropped, by the PWA and again by the relay. Lengths and durations are bucketed. Errors send
  class name, category, HTTP status and a random reference, never messages or
  stacks.
- **No lasting identity.** Each tab session gets a random id in
  `sessionStorage`, written only once an event is sent and removed on opt-out.
  It survives reloads in that tab and ends when the tab closes. The relay sets
  `$process_person_profile: false` and `$geoip_disable: true` on every event.
  No cookies, no id in `localStorage`, no URL, referrer, title or user agent
  string. Besides the session id, the only stored value is the on/off
  preference.
- **Report a problem.** A dialog sends an optional, scrubbed note with the
  last error reference. Pressing Send is its own consent, so it goes even with
  usage data off. Deployments without telemetry link to GitHub issues instead.

The event schema, retention settings and dashboards are in
[telemetry.md](../telemetry.md).

## Alternatives and tradeoffs

- **One default everywhere.** Opt-in everywhere is lawful in every region but
  yields little data; opt-out everywhere contradicts the EDPB's reading for EU
  readers. National exemptions (France's CNIL, the Netherlands) don't cover
  the whole EU, and the EU Digital Omnibus exemption is unsettled.

- **`posthog-js` with privacy options** (`autocapture: false`,
  `disable_session_recording`, `persistence: 'memory'`, `person_profiles:
'never'`, `before_send`). Gains feature flags, surveys and SDK upkeep. But it
  ships autocapture, replay and persistence code that must stay disabled, adds
  default properties (`$current_url`, `$referrer`, screen size, UA-derived
  fields) that `before_send` has to strip forever, and adds a major dependency
  to the main bundle. The direct API makes the privacy defaults hold with no
  configuration to get wrong.
- **Posting straight to PostHog from the browser**, with the key in a `VITE_`
  build variable and PostHog's origin in the CSP. Less code, but PostHog
  receives every reader's IP address (personal data until its discard setting
  drops it), the allowlist runs only on the client, previews send to whichever
  project the build names, and stopping collection needs a rebuild. The relay
  costs a Worker route with a body limit, same-origin check and throttle.
  Content blockers that block `posthog.com` no longer block Rami's counts;
  the route's path is stable and documented, so blocklists can still name it.
- **Self-hosted analytics or Workers Analytics Engine.** Keeps data first
  party, but needs funnel and dashboard tooling we would build ourselves.
- **No telemetry.** The previous position. Simplest and most private, but
  failures stay invisible unless a reader reports them.

Without a person id, funnels span one tab session, and retention and
returning-reader counts are unavailable. That is the intended cost. A
`localStorage` id would give retention but needs consent everywhere under
ePrivacy rules and was rejected. A per-load id was the first design; it split
one sitting into many sessions whenever the reader reloaded. Cloudflare
still sees the reader's IP address, as it does for every request, and the
relay's throttle holds it in isolate memory for a minute.
