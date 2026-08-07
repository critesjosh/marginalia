# Private audiobook Worker

This Worker keeps the `josh-audiobooks` R2 bucket private while allowing the
Marginalia PWA to stream the combined *Twilight of the Idols* audiobook.

The PWA exchanges a personal bearer token for 24-hour HMAC-signed URLs. Only
`audiobook.opus` and `metadata.json` are reachable; narration checkpoints stay
private. Audio is streamed directly from R2 with byte-range support.

The token and signed URL are the authorization boundary; CORS only limits which
browsers can read responses. `/session` also uses a Cloudflare rate-limit binding
(30 attempts per minute per location). Invocation logs and traces are disabled
because request URLs contain the 24-hour signature.

Required Worker secrets:

- `ACCESS_TOKEN`: the personal token entered in Marginalia settings.
- `SIGNING_KEY`: a separate random HMAC key that never leaves Cloudflare.

Set each with `wrangler secret put <NAME>`. Never add either value to this
directory or to `wrangler.jsonc`.

Keep `ALLOWED_ORIGINS` current when the production or preview hostname changes.
`SIGNED_URL_TTL_SECONDS` must be between 60 and 172800 seconds. The R2 binding is
marked `remote`, so `wrangler dev` reads the live private bucket.

Generate the ignored environment/runtime declaration with the non-secret local
variable names, then type-check and bundle:

```bash
npx wrangler types --env-file .dev.vars.example
npx tsc -p tsconfig.json
npx wrangler deploy --dry-run
```
