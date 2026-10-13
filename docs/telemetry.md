# Telemetry

Product telemetry follows [decision 0008](decisions/0008-privacy-first-telemetry.md).
The schema in `shared/telemetrySchema.ts` is the source of truth; this page
explains it. The PWA and the relay (`shared/telemetryRelay.ts`) both apply it.
Adding an event or property means changing both this page and the schema, plus
a test in `src/lib/telemetry.test.ts`.

## What is never sent

Book text, titles, authors, file names, selected passages, highlights, notes,
prompts, model replies, memory, standing instructions, emails, URLs (including
the page URL and referrer), error messages, stack traces, user agent strings,
cookies, and any id that outlasts the tab session. The only free text is the
optional note in Report a problem, after scrubbing.

## How events travel

The PWA posts batches of up to 50 events to `POST /api/telemetry/events` on
its own origin. The relay drops anything the schema does not allow, scrubs
report notes again, sets the PostHog control properties, and forwards the
batch to `<TELEMETRY_HOST>/batch/` with the project key and only a
`Content-Type` header. PostHog sees Cloudflare's address, not the reader's,
and no user agent, cookie, `Origin` or referrer. The relay refuses
cross-origin requests and bodies over 64 KB, and throttles each IP to 60
batches a minute (in isolate memory, a speed bump rather than a quota).

`GET /api/telemetry/config` tells the PWA whether this deployment collects
anything and which consent rule applies (below). Until it answers, events are
held; if it says no, or cannot be reached, nothing is sent for that page load.

## Configuration

| Variable                | Where                               | Purpose                                                                     |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `TELEMETRY_KEY`         | Worker secret; `.env.local` in dev  | Public project key, `phc_…`. The relay refuses anything else. Unset is off. |
| `TELEMETRY_HOST`        | `wrangler.jsonc` vars; `.env.local` | Ingestion origin, `https://eu.i.posthog.com`.                               |
| `TELEMETRY_DEFAULT`     | Worker var (optional); `.env.local` | `regional` (default) or `off` (opt-in everywhere).                          |
| `TELEMETRY_DEV_COUNTRY` | dev only                            | Country the local region check uses, e.g. `GB`.                             |

None of these reaches the browser. Never use a personal API key (`phx_…`).
The EU project is 303639. Production gets the key with
`wrangler secret put TELEMETRY_KEY` after privacy review; Previews get one only
if it is added to the Preview base config, ideally for a separate project so
test traffic stays out of production data (docs/operations.md).

## Common properties

Every event carries these, plus `distinct_id` (random per tab session) and the
PostHog control properties the relay sets (`$process_person_profile: false`,
`$geoip_disable: true`, `$lib: rami-web`).

| Property         | Values                                         |
| ---------------- | ---------------------------------------------- |
| `app_version`    | Commit short SHA, or `dev`                     |
| `form_factor`    | `touch`, `pointer`                             |
| `browser_family` | `chrome`, `edge`, `firefox`, `safari`, `other` |

## Events

| Event                | When                             | Properties                                                                                                                          |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `app_opened`         | Page load                        | `display_mode`: `browser`, `standalone`                                                                                             |
| `book_imported`      | An import finishes or fails      | `source`: `file`, `gutenberg`, `shared_link`; `outcome`; `error_category`                                                           |
| `reader_opened`      | A book first renders or fails to | `book_kind`: `bundled`, `imported`; `outcome`; `error_category`                                                                     |
| `text_selected`      | A selection in the book          | `length_bucket`: `under_20`, `20_199`, `200_999`, `1000_plus`                                                                       |
| `annotation_created` | A highlight is saved             | `trigger`: `highlight`, `ask`                                                                                                       |
| `annotation_deleted` | A highlight is deleted           | none                                                                                                                                |
| `ai_message_sent`    | A chat turn ends                 | `outcome`: `success`, `failure`, `canceled`; `turn`: `first`, `follow_up`; `duration_bucket`; `error_category`; `http_status`       |
| `error_occurred`     | A captured failure               | `feature`, `operation`, `error_category`, `error_name`, `http_status`, `error_ref`                                                  |
| `problem_reported`   | Report a problem is sent         | `has_feedback`, `feedback`, and the last error's `error_ref`, `feature`, `operation`, `error_category`, `error_name`, `http_status` |

`outcome` is `success` or `failure`. `duration_bucket` is `under_2s`,
`2_10s`, `10_30s` or `30s_plus`.

### Error classification

- `feature`: `app`, `import`, `reader`, `annotations`, `chat`, `feedback`.
- `operation`: `uncaught`, `unhandled_rejection`, `render`, `import_file`,
  `import_gutenberg`, `import_shared_link`, `open_book`, `save_highlight`,
  `delete_highlight`, `send_message`.
- `error_category`: `network`, `timeout`, `canceled`, `rate_limited`,
  `unavailable`, `server`, `client`, `storage`, `storage_quota`,
  `invalid_epub`, `not_found`, `unknown`.
- `error_name`: the error's class name when it matches `^[A-Z][A-Za-z]{0,39}$`.
- `error_ref`: `E-` plus six characters, random per error and kept in memory.
  The error page and Report a problem show it so a report can be matched to
  its `error_occurred` event.

Combine with `app_version` to see which build introduced a failure.

## PostHog project settings

Set these before the first event arrives:

- **Discard client IP data** (Project settings > IP data capture): on. The
  relay already withholds the reader's IP; this drops Cloudflare's too.
- **Region**: EU Cloud (`eu.i.posthog.com`) unless legal review prefers US.
- **Session replay, autocapture, heatmaps, web vitals, surveys**: off. The
  client cannot send them, but leave them off so a later SDK change cannot
  turn them on silently.
- **Person profiles**: identified only. Events already opt out.
- **Data retention**: 12 months for events, the shortest plan option that
  still covers year-over-year comparison. Shorter is fine.
- **Access**: project members only; no public dashboards or shared links that
  include `problem_reported.feedback`.

Review `problem_reported.feedback` periodically and delete any report that
contains personal data the scrubber missed (PostHog event deletion by
`error_ref` or time range).

## Example funnels

Funnels group by `distinct_id`, which lasts one tab session: it is kept in
`sessionStorage` (`marginalia.telemetry.session`) once an event is sent,
survives reloads, and ends when the tab closes or the reader opts out. They
show within-session conversion, not returning readers.

1. **First read**: `app_opened` > `reader_opened` (`outcome = success`) >
   `text_selected` > `annotation_created`.
2. **Ask Rami**: `text_selected` > `annotation_created` (`trigger = ask`) >
   `ai_message_sent` (`outcome = success`).
3. **Import to read**: `book_imported` (`outcome = success`) >
   `reader_opened` (`outcome = success`), broken down by `source`.

## Example dashboards

- **Reader health**: `reader_opened` failure rate by `app_version`;
  `error_occurred` count by `feature` and `error_category`; top
  `operation` by error count.
- **Chat**: `ai_message_sent` by `outcome` (stacked, daily);
  `rate_limited` and `unavailable` share; `duration_bucket` distribution;
  `turn = follow_up` share as an engagement signal.
- **Imports**: `book_imported` by `source` and `outcome`; `invalid_epub` and
  `network` failure shares.
- **Feedback**: `problem_reported` count, share with `error_ref`, joined to
  `error_occurred` on `error_ref`.

Suggested alert: `error_occurred` with `feature = reader` above twice its
7-day baseline for the newest `app_version`.

## Content blockers

Blockers that block `posthog.com` do not block the same-origin relay. The
path is stable and documented here, so a blocklist can still name
`/api/telemetry/events`, and GPC or Do Not Track keeps telemetry off regardless.

## Consent by region

`GET /api/telemetry/config` returns `opt_in` or `opt_out` from Cloudflare's
country for the request (`shared/telemetryRegion.ts`). The country is never
stored, logged, or sent to PostHog.

| Region                                | Default | Notice                             | Basis                                               |
| ------------------------------------- | ------- | ---------------------------------- | --------------------------------------------------- |
| EU 27, Iceland, Liechtenstein, Norway | Off     | Asks: No thanks / Share usage data | ePrivacy Art. 5(3); EDPB Guidelines 2/2023 para. 33 |
| Switzerland                           | Off     | Asks                               | Kept strict pending counsel                         |
| Unknown, Tor, or lookup failed        | Off     | Asks                               | Strictest default                                   |
| UK                                    | On      | Informs: Turn off / OK             | PECR Schedule A1 statistical-purposes exception     |
| Everywhere else                       | On      | Informs                            | No general consent requirement                      |
| Any, with GPC or Do Not Track         | Off     | None                               | Respecting the signal                               |

The notice is a bar at the foot of whichever page the reader opens first, so
a direct link to a book or a shared link shows it too. Events captured before the relay answers are held and sent only if the
default turns out to be on. Either button on the notice records a choice, so
it shows once.

## Needs legal review before production

- **Regional default**: confirm the country list (especially Switzerland),
  that the UK notice plus Settings toggle meets the ICO's "clear and
  comprehensive information" and "simple and free" objection conditions, and
  that the notice wording is adequate.
- **GDPR lawful basis**: legitimate interest is plausible for anonymous
  aggregate error data, but needs a documented balancing test. PostHog no
  longer receives readers' IP addresses, which strengthens the case that the
  counts are not personal data in its hands; Cloudflare still processes them.
- **Report a problem** sends even with usage data off, on the reader's
  explicit Send. Confirm that counts as consent for that report, and that the
  free-text note (possibly personal data despite scrubbing) has a retention
  and deletion process.
- **Processor terms**: a DPA with PostHog, EU or US hosting, and the
  transfer mechanism if US.
- **Privacy policy**: drafted at `/privacy` (`src/pages/PrivacyPage.tsx`) and
  linked from Settings and the notice. It needs counsel's review. It states
  that PostHog is EU-hosted, never receives readers' IPs, and keeps events and
  reports for up to 12 months: make those true in the PostHog project before
  enabling telemetry, or change the page.
- **Respecting GPC**: treated as an opt-out here; check whether any target
  jurisdiction requires more.
