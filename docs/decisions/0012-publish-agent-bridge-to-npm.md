# Publish the agent bridge to npm

Date: 2026-10-26
Status: Proposed

## Context

Decision 0010 runs the local agent bridge from a checkout of this repository
(`npm run agent-bridge`) and left publishing it to npm for later. Most readers
use the hosted app, not a checkout, so cloning the repository and running
`npm ci` is the largest step in pairing their own agent. The readers who want
the bridge already run Claude Code or Codex, so most have Node.js.

The bridge holds the pairing token and starts the reader's agent, so whatever
installs it is part of its threat model. A published package is a supply-chain
commitment: a compromised release would run on every reader's machine that
starts it.

## Decision

Publish the bridge as the unscoped npm package `rami-agent-bridge`, with a
`rami-agent-bridge` command, from GitHub Actions only.

- **One bundled file, no dependencies.** `scripts/build-agent-bridge.mjs`
  bundles `dev/agentBridge.ts` and the `shared/` and `src/lib/` modules it
  imports into `packages/agent-bridge/dist/rami-agent-bridge.js` with
  esbuild. The bridge imports only Node built-ins, and the build fails if
  any npm package would enter the bundle, so installing it fetches nothing
  else. Node does not strip TypeScript types inside `node_modules`, so the
  package ships JavaScript. `checks` builds the bundle and runs `--help` on
  every pull request.
- **Trusted publishing.** The manual `publish-agent-bridge` workflow
  publishes with npm's OIDC trusted publishing and provenance, so no npm
  token is stored in the repository and each release links to the commit and
  workflow run that built it. It runs in the `npm` GitHub environment, which
  should require a reviewer. It takes an existing `agent-bridge-vX.Y.Z` tag,
  refuses a tag that is not on `main` or does not match
  `packages/agent-bridge/package.json`, runs the bridge tests and the build,
  and does not use the dependency cache.
- **Pinned instructions.** Setup docs will show an exact version
  (`npx rami-agent-bridge@X.Y.Z`), not a bare `npx rami-agent-bridge`, so a
  new release runs only when the reader chooses it. The npm account that
  owns the package uses two-factor authentication.
- **Bootstrap.** npm configures a trusted publisher only for a package that
  already exists, so the owner publishes the first version once by hand,
  then adds this repository and workflow as its trusted publisher and
  disallows token publishing. Every later release goes through the workflow.
- **Checkout still works.** `npm run agent-bridge` keeps running the source
  directly, for development and for readers who prefer a checkout.

Follow-ups, after the first release: `GET /v1/status` reports the bridge
version so Settings can ask the reader to update an old bridge, and Help,
Settings and `docs/agent-bridge.md` switch to the pinned `npx` command.

## Alternatives and tradeoffs

- Keep the checkout only: no release process or supply-chain surface, but
  readers of the hosted app, the audience of decision 0010, must clone and
  install a development repository.
- Standalone binaries (Node single executable applications or
  `bun build --compile`): no Node.js needed, but a build per operating system,
  and unsigned binaries meet Gatekeeper and SmartScreen warnings. Signing and
  notarizing cost more than the readers without Node.js justify today.
- Homebrew or other package managers: they can wrap the npm release later,
  but each covers only some systems.
- A scoped name (`@rami/agent-bridge`): needs an npm organization; the
  unscoped name was free and is the one decision 0010 named.
- A long-lived npm token in repository secrets: simpler to set up, but a
  leaked token publishes without any review or provenance.
- A browser extension with native messaging: it still needs a local process
  to start the CLI, so it adds an install rather than removing one.
