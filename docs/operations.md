# Operations and privacy runbook

## Configuration and secrets

Use `.env.example` for local keys; never commit populated environment files.
The OpenRouter key is a server-side secret.
The browser holds no API keys; chat goes through the relay. Never export keys or
access tokens.

The privacy policy at `/privacy` (`src/pages/PrivacyPage.tsx`) describes every
flow of data off the device. Change it with any change to what is sent, stored,
or logged, and update its date.

Product telemetry (decision 0008) goes through the Worker's relay at
`/api/telemetry/*` and is collected only when the Worker has a `TELEMETRY_KEY`
secret (the public `phc_` project key) and `TELEMETRY_HOST`, which is in
`wrangler.jsonc`. Enable production after privacy review with
`wrangler secret put TELEMETRY_KEY`. Previews have no key unless one is added
to the Preview base config in the dashboard (Workers, Settings, Variables and
secrets); use a separate PostHog project there so test traffic stays out of
production data. Nothing is set at build time. Event schema, PostHog project
settings, retention, and dashboards are in [telemetry.md](telemetry.md). To
stop it in an emergency, run `wrangler secret delete TELEMETRY_KEY`: the relay
refuses every batch at once, without a build or deploy, and new page loads
stop capturing. Workers log only the operation metrics described below; read
them in Cloudflare Workers observability. Builds do not emit source maps.

Lost stored files and app updates are logged on the device in localStorage
(`src/lib/diagnostics.ts`), each stamped with the exact build. Nothing is sent:
Settings prefills a new GitHub issue with the log, the build, the browser and
storage status, and the reader decides whether to submit it. The log names no
books or notes.

## Health, outages, and spending

The app Worker exposes `/health`, a liveness check only. It does not call
OpenRouter. An absent inference key returns 503 for chat, not a reader
failure. Set `CHAT_ENABLED=false` on the relevant deploy target to stop paid chat
while keeping reading available. Vite and Cloudflare honor it. On
Cloudflare, use `wrangler secret put CHAT_ENABLED` so later deploys keep it.

Relay metrics log operation/status/duration, never URLs, prompts, or IPs.
The self-run agent bridge also emits local request-linked configuration,
stage, tool and final-outcome diagnostics; it classifies errors instead of
logging raw CLI text. Its opt-in private stderr file is bounded and contains
only categories. See [bridge diagnostics](agent-bridge.md#diagnosing-agent-errors).
None of those records are sent to telemetry or hosted services.
Upstream header waits stop after 30 seconds; request/error bodies have byte
limits. Five consecutive transient provider failures open an isolate-local
30-second breaker. This and IP throttling are best effort, not global budgets.
Set a hard credit cap on the provider key. No automatic retries of paid requests.

For rising 5xx rates: inspect status/duration aggregates, provider status and
credit usage, turn off chat if needed, and reproduce using fake upstream tests.

Suggested hosted alerts, after deliberate operator setup: 5xx >5% for 5 minutes
(minimum 20 requests), p95 relay header latency >20s for 10 minutes, health failures
from two locations, or provider spend >80% of the chosen cap. Link alerts to this
runbook. These are recommendations, not proof that alerts currently run.

## Published threads

Readers can publish a thread at `/t/<id>` (decision 0006). Snapshots live in the
`THREADS` Workers KV namespace, which Wrangler creates on the first deploy that
declares it, and expire a year after their last publish. Worker Previews use a
separate `marginalia-threads-preview` namespace, bound under `previews` in
`wrangler.jsonc`, and need `TURNSTILE_SECRET_KEY` in the Preview base config.

Setup: create a Turnstile widget (managed mode) for the app's host names, put
its public site key in `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY`, then
`wrangler secret put TURNSTILE_SECRET_KEY`. Until both are set, `/api/threads` answers 503 and the PWA
shows that publishing is unavailable. Dev uses Turnstile's always-pass test keys.

Abuse: add a WAF rate-limiting rule on `POST /api/threads`; the Worker's own
throttle is per isolate. `wrangler secret put THREADS_ENABLED` with `false`
stops publishing and updates; existing links keep serving and owners can
still remove them. To take down one link, `wrangler kv key delete --binding
THREADS --remote <id>`. A removal can take up to a minute to reach every edge
location. Thread metrics log operation/status/duration only, never ids,
content, or IPs.

## Release, canary, and rollback

PR checks must pass before main changes. CI produces test, coverage, and bundle
reports, but does not deploy. Review the complete diff and secret scan first.
Release/deploy only with explicit permission. Use an immutable Git tag, update
`CHANGELOG.md`, and link the PR, test evidence, and deploy version in the release.
The manual `draft-release` workflow accepts an existing version tag and generates
draft notes using issue-type labels. It does not publish a release or deploy.
Dispatch it only when explicitly authorized; it has not been run during remediation.

For Cloudflare, dry-run first, then upload an immutable Worker version and use
`wrangler versions deploy` for a small canary before 100% rollout. Monitor error
rate, health, and latency. The exact traffic split must be an explicit operator
decision. Restore the previous known-good version with `wrangler rollback`
on regression.
These actions require hosted credentials and authorization; local QA never runs
them. No deployment-frequency or successful-rollback claim follows from this doc.

## Browser releases

The nightly `browser-canary` workflow runs QA in three legs:

- `chrome` and `chrome-beta`: the Chromium projects in branded Chrome
  (`npm run test:qa:canary`, channel from `QA_CHANNEL`, default `chrome-beta`).
- `playwright-next`: every project on Playwright's prerelease, whose Firefox
  and WebKit builds run ahead of the pinned version's. This is the early
  warning for Firefox and Safari; real Safari and iOS still need a manual check.

A failure opens or updates one issue per leg, which closes when that leg passes
again. If only beta or `playwright-next` fails, a coming browser change (or, for
`playwright-next`, a Playwright change) is the likely cause: fix it or report it
upstream before release.

## Shared book links

Readers can share a Project Gutenberg book at `/b/<id>` (decision 0007). The
card (title, author, Gutenberg id and a JPEG cover under 256 KB) lives in the
same `THREADS` namespace under `book:<id>`, with the same one-year expiry,
Turnstile keys and `THREADS_ENABLED` switch. `/b/<id>` serves the app with the
card's preview tags; `/b/<id>/cover` serves the image. Add `POST /api/books` to
the WAF rate-limiting rule. To take down one link, `wrangler kv key delete
--binding THREADS --remote book:<id>`. Metrics use the `books` operation name.

Dependabot bumps Playwright in its own PR, since that bump also replaces the
bundled browsers.

## Data requests and error-to-issue flow

Books, notes, conversations, and personal keys stay on the reader's device,
except threads and book cards a reader publishes. A reader removes a published
link from the thread, or from the book's Share book dialog; for a request by
email, delete the key as described above.
Use the UI's export/delete controls for reader data. Clear browser site data for
complete local removal.

Do not attach private books or conversations to bugs. File a bug using the
template, assign priority/type/area labels, reference the failing synthetic
regression, then close only after a verified fix. No bot posts externally without explicit authorization.
