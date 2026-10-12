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

- **PostHog Cloud, through its public capture API.** The PWA posts batches to
  `<host>/batch/` with the project key. It does not load `posthog-js`.
- **Off unless configured.** A build sends nothing unless `VITE_POSTHOG_KEY`
  (a public `phc_` project key) and `VITE_POSTHOG_HOST` are set, and the
  Worker's CSP blocks the host unless `TELEMETRY_ORIGIN` is set. Production
  sets neither until privacy review. The build rejects any other key type.
- **Consent first, by region.** Before the reader chooses, the default comes
  from `GET /api/telemetry/region`, which maps Cloudflare's country for the
  request (read, never stored or logged) to a rule. The EU, EEA, Switzerland
  and unknown countries are opt-in: the EDPB reads ePrivacy Article 5(3) as
  covering JavaScript that sends data from the device, and analytics is not
  exempt. Elsewhere, including the UK under PECR's statistical-purposes
  exception (in force 5 February 2026), it is opt-out with notice. Events are
  held, unsent, until the region is known. A one-time notice, shown on
  whichever page the reader lands, asks (opt-in) or informs with a Turn off button (opt-out); declining is as
  easy as accepting. Global Privacy Control or Do Not Track keeps it off with
  no notice. `VITE_TELEMETRY_DEFAULT=off` makes it opt-in everywhere. The
  Settings toggle changes it at any time and drops queued events.
- **Allowlisted events and properties.** `src/lib/telemetrySchema.ts` names
  every event and the enum, boolean or bounded values each property may take.
  Everything else is dropped. Lengths and durations are bucketed. Errors send
  class name, category, HTTP status and a random reference, never messages or
  stacks.
- **No identity.** Each page load gets a random id held in memory. Events set
  `$process_person_profile: false` and `$geoip_disable: true`. No cookies, no
  stored id, no URL, referrer, title or user agent string. The only stored
  value is the on/off preference.
- **Report a problem.** A dialog sends an optional, scrubbed note with the
  last error reference. Pressing Send is its own consent, so it goes even with
  usage data off. Builds without telemetry link to GitHub issues instead.

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
- **A Cloudflare Worker proxy** (`/api/t` forwarding to PostHog). Hides the
  reader's IP from PostHog, keeps `connect-src 'self'`, and survives content
  blockers. Costs a Worker route and its abuse controls. Left as a second
  phase; the client only needs its host changed.
- **Self-hosted analytics or Workers Analytics Engine.** Keeps data first
  party, but needs funnel and dashboard tooling we would build ourselves.
- **No telemetry.** The previous position. Simplest and most private, but
  failures stay invisible unless a reader reports them.

Without a person id, funnels and retention only span one page load, and
returning-reader counts are unavailable. That is the intended cost. PostHog
still receives each request's IP address; the project must discard it (see
telemetry.md) until the proxy exists.
