# Marginalia Databricks services diagram

Editable tldraw SDK canvas explaining the Databricks architecture in PR #39,
the purpose of each platform service, alternatives by layer, current review
findings, and privacy-safe live workspace telemetry.

```sh
npm install
npm run dev
```

The development server listens on `127.0.0.1:4174`. From another machine, use
an SSH tunnel and open `http://localhost:4174`:

```sh
ssh -L 4174:127.0.0.1:4174 <user>@<remote-host>
```

Canvas changes persist in that browser under the tldraw persistence key
`marginalia-databricks-services-v1`.

The server uses the local Databricks CLI profile named `me` by default. Override
it with `DATABRICKS_PROFILE=<profile> npm run preview`. Automatic health updates
read resource and Unity Catalog metadata only. The explicit **Load row counts**
action runs SQL and can start the configured serverless SQL Warehouse.

The control center can start two allowlisted, non-destructive jobs: the full
intelligence refresh and the Librarian refresh. It checks for an active run
before queuing another and requires a browser confirmation because either action
can start billable compute. Deletion jobs, cancellation, service stop controls,
and arbitrary job ids are intentionally not exposed. Live workspace links open
the matching Databricks resource in a new browser tab.

`npm run publish:dashboard` updates only the existing Marginalia development
dashboard from the checked-in `.lvdash.json`, targets the per-reader scoped
schema, publishes it without embedded publisher credentials, and verifies the
live draft and published metadata. The source file stays portable, while the
publishing step fully qualifies every live query with the development catalog
and scoped schema. It intentionally avoids a full bundle deploy.

Only aggregate status, table names, timestamps, and row counts are returned to
the browser. The server does not expose user IDs, book titles, highlights,
questions, provider response bodies, workspace URLs, or credentials.
