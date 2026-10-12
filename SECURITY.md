# Security

Report suspected vulnerabilities privately to the repository owner via GitHub
security reporting when available. Do not post keys, signed URLs, personal EPUBs,
or exported conversations in public issues. If private reporting is unavailable,
contact the owner before sending sensitive reproduction material.

EPUBs are untrusted. Scripts remain disabled, CSP remains restrictive, and XML
entity resolution must stay off. Use synthetic payloads for reproduction.
Books and keys stay local except for explicitly requested model-provider calls.
Optional product telemetry is off unless configured, respects the reader's
setting and browser privacy signals, and never sends book content, notes,
chats, or URLs. Only the public PostHog project key may reach the browser. See
`docs/telemetry.md` for the schema, retention, and scrubbing, and
`docs/operations.md` for secrets and incident response.
